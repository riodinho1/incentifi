import { keccak256, encodeAbiParameters, parseAbiParameters, encodeFunctionData, parseAbi, getAddress } from 'viem';
import { getEvmProvider, publicClient, waitForTransactionReceipt } from './evmNetwork';
import { INCENTIFI_V4_FACTORY, INCENTIFI_V4_ROUTER, INCENTIFI_V4_HOOK } from './uniswapAddresses';
import {
  TOTAL_TOKEN_SUPPLY,
  GRADUATION_ETH_TARGET,
  REFERENCE_ETH_USD,
  calculateTokensOut,
  calculateEthOut,
  BondingCurveState,
} from './bondingCurve';

// ----------------------------------------------------------------------------
// V4 wiring notes
// ----------------------------------------------------------------------------
// There is no per-token curve contract in V4 — every launched token shares one
// hook instance (INCENTIFI_V4_HOOK), and its state lives in that hook's own
// curveStates(poolId) mapping, keyed by a PoolId derived from the token's
// PoolKey rather than looked up by address. The pre-graduation bonding-curve
// MATH (VIRTUAL_ETH/VIRTUAL_TOKEN/INVARIANT_K/GRADUATION_ETH_TARGET, the 1%/1%
// fee split, the clamp+refund formula) is byte-identical to the v3 curve, so
// this module reuses calculateTokensOut/calculateEthOut from ./bondingCurve
// rather than re-deriving the same formulas a second time.
//
// currency0 is ALWAYS native ETH (address(0)) and currency1 is ALWAYS the
// launched token, for every V4 pool, unconditionally (address(0) is
// numerically the smallest possible address) — unlike the v3/Uniswap-V3 side,
// there is no "which token sorts first" ambiguity to resolve here at all.
//
// IMPORTANT LIMITATION, not silently worked around: IncentifiV4Router.buyToken()
// /sellToken() both revert once a pool has graduated (PoolGraduated()) — that
// router is deliberately pre-graduation-only (see IncentifiV4Router.sol's own
// header comment). Post-graduation trading requires a raw PoolManager caller
// implementing IUnlockCallback (contracts/v4/test-helpers/GenericV4Bot.sol is
// the only one that exists today, built test-only, not deployed as permanent
// shared infrastructure — and no real generic V4 router/UniversalRouter was
// found deployed on Robinhood Chain either). executeV4Buy/executeV4Sell below
// throw a clear error for a graduated V4 pool rather than attempting a call
// that would either revert on-chain or silently rely on infrastructure that
// doesn't exist yet. State reading (fetchV4CurveState) works correctly for a
// graduated V4 pool regardless — only the trade-execution path is blocked.

const V4_FACTORY_ABI = parseAbi([
  'function isLaunched(address token) view returns (bool)',
  'function getPoolKey(address token) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))',
]);

// curveStates is a public mapping to a struct — Solidity's auto-generated
// getter for a struct-valued mapping returns each field as a SEPARATE value
// (not one nested tuple), hence the multi-value `returns (...)` shape below
// rather than a single struct return type.
const V4_HOOK_ABI = parseAbi([
  'function curveStates(bytes32 poolId) view returns (address token, address creator, bool initialized, bool graduated, uint256 realEthReserve, uint256 realTokenReserve)',
]);

const V4_ROUTER_ABI = parseAbi([
  'function buyToken(address token, uint256 minTokensOut, uint256 deadline) payable returns (uint256 tokensOut)',
  'function sellToken(address token, uint256 tokenAmountIn, uint256 minEthOut, uint256 deadline) returns (uint256 netEthOut)',
]);

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

// The real, already-deployed, independently-verified StateView contract —
// reads a V4 pool's live price/liquidity directly from PoolManager's own
// storage, same contract used throughout this engagement's deploy/verify
// scripts to cross-check on-chain state.
const STATE_VIEW_ADDRESS = getAddress('0xf3334192d15450cdd385c8b70e03f9a6bd9e673b');
const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
]);

export type V4PoolKey = {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
};

const waitForReceipt = waitForTransactionReceipt;
const toQuantityHex = (value: bigint) => `0x${value.toString(16)}`;

/**
 * Computes a V4 PoolId the same way PoolIdLibrary.toId() does on-chain:
 * keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)).
 * Matches the exact formula already used and cross-checked in this
 * engagement's deploy/verify scripts.
 */
export function computeV4PoolId(key: V4PoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters('address, address, uint24, int24, address'),
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    )
  );
}

/**
 * Checks whether `tokenAddress` was launched through the V4 factory. Cheap,
 * single boolean read — used to route between V3 and V4 state/trading logic
 * without needing any off-chain registry.
 */
export async function isV4LaunchedToken(tokenAddress: string): Promise<boolean> {
  const token = getAddress(tokenAddress);
  const launched = await publicClient.readContract({
    address: getAddress(INCENTIFI_V4_FACTORY),
    abi: V4_FACTORY_ABI,
    functionName: 'isLaunched',
    args: [token],
  } as any);
  return Boolean(launched);
}

/**
 * Reads the real PoolKey for `tokenAddress` from the V4 factory itself, rather
 * than reconstructing it from locally-duplicated POOL_FEE/TICK_SPACING
 * constants — the factory's getPoolKey() is the single source of truth
 * IncentifiV4Router itself also calls through to, so there is nothing for a
 * locally-duplicated copy of those constants to silently drift out of sync with.
 */
export async function getV4PoolKey(tokenAddress: string): Promise<V4PoolKey> {
  const token = getAddress(tokenAddress);
  const key = await publicClient.readContract({
    address: getAddress(INCENTIFI_V4_FACTORY),
    abi: V4_FACTORY_ABI,
    functionName: 'getPoolKey',
    args: [token],
  } as any);
  return key as V4PoolKey;
}

export interface V4CurveState extends BondingCurveState {
  isV4: true;
  hookAddress: `0x${string}`;
  poolId: `0x${string}` | null;
  poolKey: V4PoolKey | null;
  /** False for a graduated V4 pool — see this file's header comment for why. */
  tradingSupported: boolean;
}

/**
 * Fetches the on-chain V4 curve state for a token directly via Robinhood Chain
 * RPC. Returns the same BondingCurveState shape the v3 fetchBondingCurveState()
 * does (plus V4-specific fields) so callers that only need the common fields
 * don't need to branch on version.
 */
export async function fetchV4CurveState(
  tokenAddress: string,
  ethPriceUsd: number = REFERENCE_ETH_USD
): Promise<V4CurveState> {
  const normalizedToken = getAddress(tokenAddress);
  const poolKey = await getV4PoolKey(normalizedToken);
  const poolId = computeV4PoolId(poolKey);

  let curveRaw: readonly [string, string, boolean, boolean, bigint, bigint];
  try {
    curveRaw = (await publicClient.readContract({
      address: getAddress(INCENTIFI_V4_HOOK),
      abi: V4_HOOK_ABI,
      functionName: 'curveStates',
      args: [poolId],
    } as any)) as any;
  } catch (error) {
    throw new Error(
      `RPC error while reading V4 hook curveStates for token ${normalizedToken} (poolId ${poolId}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }

  const [, , initialized, graduated, realEthReserveRaw, realTokenReserveRaw] = curveRaw;
  const realEthReserve = BigInt(realEthReserveRaw ?? 0n);
  const realTokenReserve = BigInt(realTokenReserveRaw ?? TOTAL_TOKEN_SUPPLY);

  if (!initialized) {
    // Registered with the factory but not yet initialized on-chain (should be
    // momentary — launchToken() initializes atomically — but handled rather
    // than assumed away).
    return {
      isV4: true,
      hookAddress: getAddress(INCENTIFI_V4_HOOK),
      poolId,
      poolKey,
      tradingSupported: false,
      curveAddress: null,
      initialized: false,
      graduated: false,
      realEthReserve: 0n,
      realTokenReserve: TOTAL_TOKEN_SUPPLY,
      progressBps: 0,
      currentPriceEth: 0,
      marketCapUsd: 0,
      circulatingTokens: 0,
      uniswapPoolAddress: null,
    };
  }

  // Circulating supply = TOTAL_SUPPLY - realTokenReserve holds true both pre-
  // and post-graduation: realTokenReserve is only ever decremented by real
  // buys before graduation, and _graduate() never writes to it afterward
  // (it's read once, to size the liquidity deposit, then frozen) — ordinary
  // post-graduation AMM swaps move tokens between wallets and the pool's own
  // reserve, never mint or burn, so this stays an honest circulating figure
  // in both regimes (unlike v3's hardcoded post-graduation constant).
  const circulatingTokens = Number(TOTAL_TOKEN_SUPPLY - realTokenReserve) / 1e18;

  if (!graduated) {
    const currentEth = 2_156_250_000_000_000_000n + realEthReserve; // VIRTUAL_ETH, kept local to avoid a second import just for this one constant
    const currentToken = 78_125_000_000_000_000_000_000_000n + realTokenReserve; // VIRTUAL_TOKEN
    const priceEth = Number(currentEth) / Number(currentToken);
    const progressBps = realEthReserve >= GRADUATION_ETH_TARGET
      ? 10000
      : Number((realEthReserve * 10000n) / GRADUATION_ETH_TARGET);

    return {
      isV4: true,
      hookAddress: getAddress(INCENTIFI_V4_HOOK),
      poolId,
      poolKey,
      tradingSupported: true,
      curveAddress: null,
      initialized: true,
      graduated: false,
      realEthReserve,
      realTokenReserve,
      progressBps,
      currentPriceEth: priceEth,
      marketCapUsd: 1_000_000_000 * priceEth * ethPriceUsd,
      circulatingTokens,
      uniswapPoolAddress: null,
    };
  }

  // Graduated: read the real, live price directly from the core V4 pool via
  // StateView (an independent, already-deployed Uniswap contract this app
  // doesn't control) rather than from this hook's own (frozen) bookkeeping.
  let priceEth = 0;
  let poolAddress: `0x${string}` | null = null;
  try {
    const slot0 = await publicClient.readContract({
      address: STATE_VIEW_ADDRESS,
      abi: STATE_VIEW_ABI,
      functionName: 'getSlot0',
      args: [poolId],
    } as any);
    const sqrtPriceX96 = BigInt((slot0 as any)[0]);
    if (sqrtPriceX96 > 0n) {
      // currency0 is always native ETH and currency1 is always the token for
      // every V4 pool here, unconditionally — no "which side sorts first"
      // branch needed, unlike the v3/Uniswap-V3 equivalent.
      const Q96 = 2 ** 96;
      const sqrtP = Number(sqrtPriceX96) / Q96;
      const tokenPerEth = sqrtP * sqrtP; // currency1 (token) per currency0 (ETH)
      priceEth = tokenPerEth > 0 ? 1 / tokenPerEth : 0; // ETH per token
    }
    // V4 pools have no separate "pool address" the way Uniswap V3 does — the
    // pool lives inside the shared PoolManager, addressed by poolId. Surfacing
    // the hook address here instead, as the closest on-chain analog for a
    // block-explorer link.
    poolAddress = getAddress(INCENTIFI_V4_HOOK);
  } catch {
    // Fall back to the frozen graduation-time spot price rather than throwing —
    // matches the v3 UnifiedMarketState fallback behavior for a StateView hiccup.
    const currentEth = 2_156_250_000_000_000_000n + realEthReserve;
    const currentToken = 78_125_000_000_000_000_000_000_000n + realTokenReserve;
    priceEth = Number(currentEth) / Number(currentToken);
  }

  return {
    isV4: true,
    hookAddress: getAddress(INCENTIFI_V4_HOOK),
    poolId,
    poolKey,
    // See this file's header comment: IncentifiV4Router reverts on any
    // post-graduation trade, and no permanent generic-swap contract is
    // deployed yet — real trading isn't wired up for a graduated V4 pool.
    tradingSupported: false,
    curveAddress: null,
    initialized: true,
    graduated: true,
    realEthReserve,
    realTokenReserve,
    progressBps: 10000,
    currentPriceEth: priceEth,
    marketCapUsd: 1_000_000_000 * priceEth * ethPriceUsd,
    circulatingTokens,
    uniswapPoolAddress: poolAddress,
  };
}

/**
 * Real pre-graduation buy through the (verified) production IncentifiV4Router.
 * Throws if the pool has already graduated — see this file's header comment.
 */
export async function executeV4Buy(
  tokenAddress: string,
  grossEthWei: bigint,
  minTokensOutWei: bigint,
  graduated: boolean
): Promise<{ txHash: string; receipt: any }> {
  if (graduated) {
    throw new Error(
      'This token has graduated to a real, permissionless V4 pool. Trading it directly through this site isn\'t ' +
      'wired up yet — IncentifiV4Router only supports pre-graduation trades, and post-graduation V4 trading needs ' +
      'its own dedicated router, which hasn\'t been deployed. Trade it through a generic V4-aware venue instead.'
    );
  }

  const provider = getEvmProvider();
  if (!provider) throw new Error('No EVM wallet detected. Please connect your wallet.');

  const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
  const sender = accounts?.[0];
  if (!sender) throw new Error('Wallet is connected, but no active account was found.');

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const data = encodeFunctionData({
    abi: V4_ROUTER_ABI,
    functionName: 'buyToken',
    args: [getAddress(tokenAddress), minTokensOutWei, deadline],
  });

  const txHash = (await provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: sender,
        to: getAddress(INCENTIFI_V4_ROUTER),
        value: toQuantityHex(grossEthWei),
        data,
      },
    ],
  })) as string;

  const receipt = await waitForReceipt(txHash);
  return { txHash, receipt };
}

/**
 * Real pre-graduation sell through the (verified) production IncentifiV4Router.
 * Throws if the pool has already graduated — see this file's header comment.
 */
export async function executeV4Sell(
  tokenAddress: string,
  tokensInWei: bigint,
  minEthOutWei: bigint,
  graduated: boolean
): Promise<{ txHash: string; receipt: any }> {
  if (graduated) {
    throw new Error(
      'This token has graduated to a real, permissionless V4 pool. Trading it directly through this site isn\'t ' +
      'wired up yet — IncentifiV4Router only supports pre-graduation trades, and post-graduation V4 trading needs ' +
      'its own dedicated router, which hasn\'t been deployed. Trade it through a generic V4-aware venue instead.'
    );
  }

  const provider = getEvmProvider();
  if (!provider) throw new Error('No EVM wallet detected. Please connect your wallet.');

  const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
  const sender = accounts?.[0];
  if (!sender) throw new Error('Wallet is connected, but no active account was found.');

  const normalizedToken = getAddress(tokenAddress);
  const senderAddr = getAddress(sender);
  const router = getAddress(INCENTIFI_V4_ROUTER);

  const allowanceData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [senderAddr, router],
  });
  const allowanceHex = await provider.request({
    method: 'eth_call',
    params: [{ to: normalizedToken, data: allowanceData }, 'latest'],
  });
  const currentAllowance = BigInt(allowanceHex || '0x0');

  if (currentAllowance < tokensInWei) {
    const approveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [router, 2n ** 256n - 1n],
    });
    const approveTxHash = (await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from: senderAddr, to: normalizedToken, data: approveData }],
    })) as string;
    await waitForReceipt(approveTxHash);
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const data = encodeFunctionData({
    abi: V4_ROUTER_ABI,
    functionName: 'sellToken',
    args: [normalizedToken, tokensInWei, minEthOutWei, deadline],
  });

  const txHash = (await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: senderAddr, to: router, data }],
  })) as string;

  const receipt = await waitForReceipt(txHash);
  return { txHash, receipt };
}

export { calculateTokensOut as calculateV4TokensOut, calculateEthOut as calculateV4EthOut };
