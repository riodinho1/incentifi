import { encodeFunctionData, parseAbi, getAddress } from 'viem';
import { getEvmProvider, publicClient, waitForTransactionReceipt } from './evmNetwork';
import { PERMIT2_ADDRESS, UNIVERSAL_ROUTER_ADDRESS } from './uniswapAddresses';

// ----------------------------------------------------------------------------
// "Allow external bots to sell this token" — a deliberately separate, explicitly
// user-initiated action. NEVER call enableExternalBotSelling() from the buy/sell flow:
// silently bundling a broad, indefinite approval into an unrelated action is the exact
// shape of a wallet-drainer dark pattern, even though the mechanism itself (Permit2,
// UniversalRouter) is standard, real Uniswap infrastructure. Every step here is a plain
// on-chain transaction the caller's own wallet signs and pays gas for — no signatures,
// no relayer. (A gasless, relayer-paid version was considered and deliberately deferred:
// Permit2.permit() is callable by anyone once signed, so a public relay endpoint needs
// its own scoping/rate-limiting work before it's safe to stand up.)
//
// Why this is needed at all: this launchpad's token template
// (contracts/IncentifiLaunchToken.sol) has no EIP-2612 permit() — independently confirmed
// on real deployed bytecode (DOMAIN_SEPARATOR() and nonces() both revert) — so there is no
// gasless way to grant Permit2 an ERC20 allowance. A third-party trading bot that routes
// sells through Permit2 + UniversalRouter (a common pattern for generic, non-Incentifi-
// aware bots) can only do so once BOTH of the two approvals below exist.
// ----------------------------------------------------------------------------

const ERC20_ALLOWANCE_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const PERMIT2_ABI = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration) external',
]);

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;

// Permit2's own point over a plain ERC20 approval is that its allowances expire — using
// MAX_UINT48 (effectively forever) throws that away and just reproduces the same
// "approved forever" problem a year down the line instead of never. One year is long
// enough that re-approval is rare, short enough that a compromised/abandoned router
// address doesn't stay armed indefinitely. Exported so the UI can show the real expiry
// date computed at approval time, not a value re-derived (and liable to drift) elsewhere.
export const PERMIT2_APPROVAL_DURATION_SECONDS = 365n * 24n * 60n * 60n;

// A remaining-validity floor for "still counts as enabled" — short enough that this
// genuinely reflects on-chain reality (not just "was it ever approved"), long enough that
// the status check isn't itself flapping day-to-day as a real approval nears its real
// expiry. Chosen independently of PERMIT2_APPROVAL_DURATION_SECONDS on purpose: a fresh
// approval clears this floor by ~360 days of margin.
const MIN_REMAINING_VALIDITY_SECONDS = 5n * 24n * 60n * 60n;

// Treated as "already approved" without requiring an exact bit-for-bit match against
// MAX_UINT256/MAX_UINT160 — a prior, merely-very-large approval still counts. Mirrors the
// same near-max convention Uniswap's own frontend uses for ERC20/Permit2 allowances.
const NEAR_MAX_UINT256_THRESHOLD = MAX_UINT256 / 2n;
const NEAR_MAX_UINT160_THRESHOLD = MAX_UINT160 / 2n;

export interface ExternalBotSellingStatus {
  erc20ApprovedToPermit2: boolean;
  permit2ApprovedToRouter: boolean;
  fullyEnabled: boolean;
  /** Null if there is no (or an expired/insufficient) Permit2-level approval yet. */
  permit2ExpiresAt: Date | null;
}

/**
 * Read-only check — safe to call anytime, no wallet transaction involved.
 */
export async function getExternalBotSellingStatus(
  tokenAddress: string,
  ownerAddress: string
): Promise<ExternalBotSellingStatus> {
  const token = getAddress(tokenAddress);
  const owner = getAddress(ownerAddress);

  const erc20Allowance = await publicClient.readContract({
    address: token,
    abi: ERC20_ALLOWANCE_ABI,
    functionName: 'allowance',
    args: [owner, PERMIT2_ADDRESS],
  });
  const erc20ApprovedToPermit2 = erc20Allowance > NEAR_MAX_UINT256_THRESHOLD;

  const [amount, expiration] = await publicClient.readContract({
    address: PERMIT2_ADDRESS,
    abi: PERMIT2_ABI,
    functionName: 'allowance',
    args: [owner, token, UNIVERSAL_ROUTER_ADDRESS],
  });
  const expirationBig = BigInt(expiration);
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const permit2ApprovedToRouter =
    BigInt(amount) > NEAR_MAX_UINT160_THRESHOLD && expirationBig > nowSeconds + MIN_REMAINING_VALIDITY_SECONDS;

  return {
    erc20ApprovedToPermit2,
    permit2ApprovedToRouter,
    fullyEnabled: erc20ApprovedToPermit2 && permit2ApprovedToRouter,
    permit2ExpiresAt: permit2ApprovedToRouter ? new Date(Number(expirationBig) * 1000) : null,
  };
}

export type EnableBotSellingStep = 'erc20-approve' | 'permit2-approve';

/**
 * Runs whichever of the two on-chain approvals aren't already in place, in order, each
 * as its own wallet-prompted, wallet-paid transaction. Safe to call repeatedly — already-
 * satisfied steps are skipped (checked fresh via getExternalBotSellingStatus each time).
 */
export async function enableExternalBotSelling(
  tokenAddress: string,
  onStep?: (step: EnableBotSellingStep, txHash: string) => void
): Promise<{ steps: EnableBotSellingStep[] }> {
  const provider = getEvmProvider();
  if (!provider) throw new Error('No EVM wallet detected. Please connect your wallet.');

  const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
  const sender = accounts?.[0];
  if (!sender) throw new Error('Wallet is connected, but no active account was found.');

  const token = getAddress(tokenAddress);
  const owner = getAddress(sender);
  const performed: EnableBotSellingStep[] = [];

  const status = await getExternalBotSellingStatus(token, owner);

  if (!status.erc20ApprovedToPermit2) {
    const data = encodeFunctionData({
      abi: ERC20_ALLOWANCE_ABI,
      functionName: 'approve',
      args: [PERMIT2_ADDRESS, MAX_UINT256],
    });
    const txHash = (await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from: owner, to: token, data }],
    })) as string;
    await waitForTransactionReceipt(txHash, { description: 'Permit2 token approval' });
    performed.push('erc20-approve');
    onStep?.('erc20-approve', txHash);
  }

  if (!status.permit2ApprovedToRouter) {
    // uint48 expiration, NOT uint256 — only the ERC20 approve() above takes a real
    // uint256 max. A one-year-out timestamp fits comfortably (uint48 covers dates far
    // past any realistic expiration here); passing the wrong width either throws at
    // encoding or truncates silently, so this is deliberately computed as a plain unix
    // timestamp rather than reused from the uint160/uint256 constants above.
    const expiration = BigInt(Math.floor(Date.now() / 1000)) + PERMIT2_APPROVAL_DURATION_SECONDS;
    const data = encodeFunctionData({
      abi: PERMIT2_ABI,
      functionName: 'approve',
      args: [token, UNIVERSAL_ROUTER_ADDRESS, MAX_UINT160, expiration],
    });
    const txHash = (await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from: owner, to: PERMIT2_ADDRESS, data }],
    })) as string;
    await waitForTransactionReceipt(txHash, { description: 'Universal Router Permit2 approval' });
    performed.push('permit2-approve');
    onStep?.('permit2-approve', txHash);
  }

  return { steps: performed };
}
