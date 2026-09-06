// Verified on-chain against Robinhood Chain mainnet, not just trusted from docs:
// PositionManager.factory() and PositionManager.WETH9() were called directly and
// cross-checked against these exact addresses; SwapRouter02.factory() and .WETH9()
// were independently checked the same way and match too. WETH's own symbol()/decimals()
// were also read directly and confirm a real 18-decimal "WETH" token.
// Override via env vars to point at testnet equivalents for testing.

export const UNISWAP_V3_FACTORY = String(
  import.meta.env.VITE_UNISWAP_V3_FACTORY || '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA'
).trim() as `0x${string}`;

export const UNISWAP_POSITION_MANAGER = String(
  import.meta.env.VITE_UNISWAP_POSITION_MANAGER || '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3'
).trim() as `0x${string}`;

export const UNISWAP_SWAP_ROUTER = String(
  import.meta.env.VITE_UNISWAP_SWAP_ROUTER || '0xcaf681a66d020601342297493863e78c959e5cb2'
).trim() as `0x${string}`;

// Verified against https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments
// and confirmed live via eth_getCode on Robinhood Chain mainnet (chain 4663). Used for simulating
// post-graduation swap quotes without executing a trade (quoteExactInputSingle/quoteExactOutputSingle).
export const UNISWAP_QUOTER_V2 = String(
  import.meta.env.VITE_UNISWAP_QUOTER_V2 || '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7'
).trim() as `0x${string}`;

export const INCENTIFI_SWAP_ROUTER = String(
  import.meta.env.VITE_INCENTIFI_SWAP_ROUTER || '0x4c1f4197b5eebb6cc15c37e053f963a56787575e'
).trim() as `0x${string}`;

export const LOSS_REWARD_POOL = String(
  import.meta.env.VITE_LOSS_REWARD_POOL || '0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf'
).trim() as `0x${string}`;

export const INCENTIFI_BONDING_CURVE_FACTORY = String(
  import.meta.env.VITE_INCENTIFI_BONDING_CURVE_FACTORY || '0xa0143de84fba1753b887e4e32941e4fb342e473f'
).trim() as `0x${string}`;

// V4: new token launches go through this factory/router/hook instead of the V3
// ones above (which remain here, unchanged, so already-launched V3 tokens stay
// tradeable). This is IncentifiV4HookNoPostGradFee — the core, already
// real-mainnet-proven bonding-curve/graduation logic at full production
// economics ($5,000 launch / $69,000 graduation), wired to the real production
// LossRewardPool — WITHOUT the newer afterSwap post-graduation fee mechanism
// (that 6-flag hook remains deployed and paused pending funding). Once a token
// launched here graduates, its pool trades with zero Incentifi protocol fee —
// deliberate, not a bug: see contracts/v4/IncentifiV4HookNoPostGradFee.sol's
// header comment. Independently verified on-chain (code, cross-wiring,
// deployer, lossRewardPool == real production pool, GRADUATION_ETH_TARGET ==
// full production value) before this address was ever used here.
export const INCENTIFI_V4_FACTORY = String(
  import.meta.env.VITE_INCENTIFI_V4_FACTORY || '0xdEca2efDB578B6E5F298885b97F64d52f92f5Aa9'
).trim() as `0x${string}`;

export const INCENTIFI_V4_ROUTER = String(
  import.meta.env.VITE_INCENTIFI_V4_ROUTER || '0x0666399367fa585d672BF793158b35290b7F4082'
).trim() as `0x${string}`;

// The shared hook every V4-launched token's pool uses. Not a per-token
// contract (unlike the V3 bonding curve) — there is no "curve address" for a
// V4 token; its state lives in this hook's own curveStates(poolId) mapping.
export const INCENTIFI_V4_HOOK = String(
  import.meta.env.VITE_INCENTIFI_V4_HOOK || '0x5bBcf2CDAAA00c285eEc903AA1E2aB9142782888'
).trim() as `0x${string}`;

// Canonical Uniswap Permit2 + UniversalRouter deployments on Robinhood Chain mainnet.
// Independently verified on-chain before use here: both addresses have real deployed
// bytecode; Permit2.DOMAIN_SEPARATOR() returns a real, non-zero value; Permit2.allowance()
// responds with the expected (uint160 amount, uint48 expiration, uint48 nonce) shape.
// Used by src/lib/permit2.ts's "allow external bots to sell this token" flow — a
// deliberately separate, explicitly-labeled action, never bundled into buyToken/sellToken.
export const PERMIT2_ADDRESS = String(
  import.meta.env.VITE_PERMIT2_ADDRESS || '0x000000000022D473030F116dDEE9F6B43aC78BA3'
).trim() as `0x${string}`;

export const UNIVERSAL_ROUTER_ADDRESS = String(
  import.meta.env.VITE_UNIVERSAL_ROUTER_ADDRESS || '0x8876789976dEcBfCbBbe364623C63652db8C0904'
).trim() as `0x${string}`;

export const WETH_ADDRESS = String(
  import.meta.env.VITE_WETH_ADDRESS || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'
).trim() as `0x${string}`;

// Standard EVM burn address - tokens/NFTs sent here can never be moved again.
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const;

// 1% fee tier (matches how comparable Robinhood Chain launchpads seed new-token pools).
export const POOL_FEE = 10_000;

// 2.0% Total Protocol Trading Fee (1.0% Creator / 1.0% Loss Reward Pool)
export const PROTOCOL_FEE_BPS = 200;
export const CREATOR_FEE_BPS = 100;
export const LOSS_REWARD_FEE_BPS = 100;
export const BPS_DENOMINATOR = 10_000;

// Full-range ticks for the 1% fee tier (tick spacing 200).
export const TICK_LOWER = -887_200;
export const TICK_UPPER = 887_200;

