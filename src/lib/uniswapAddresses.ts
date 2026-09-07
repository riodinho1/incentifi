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
// tradeable). This is IncentifiV4HookGenericSell — IncentifiV4HookNoPostGradFee's
// exact bonding-curve/graduation logic at full production economics ($5,000
// launch / $69,000 graduation), wired to the real production LossRewardPool,
// no fee of any kind once graduated — PLUS the claims-based sell fix: a
// pre-graduation sell receives tokens as ERC-6909 claims instead of a physical
// take(), so generic V4 routers and third-party bots (which settle AFTER
// swap()) can sell, not only IncentifiV4Router. Root cause, fix rationale and
// the fork-test evidence: contracts/v4/IncentifiV4HookGenericSell.sol's header.
// Independently verified on-chain after deployment (flag bits 0x2888,
// deployer, lossRewardPool == real production pool, GRADUATION_ETH_TARGET /
// VIRTUAL_ETH == production values, exact 4-flag permission set, and the
// factory/hook/router cross-wiring) before these addresses were used here.
//
// The PREVIOUS hook (IncentifiV4HookNoPostGradFee, 0x5bBcf2CD…) and its factory
// (0xdEca2efD…) / router (0x0666399…) stay live on-chain. Tokens launched on
// them (TESTTT, TESST, TESTING) are permanently bound to that hook — a pool's
// hook address is immutable — and are deliberately NOT resolved by this site
// any more (a single-factory lookup was chosen over multi-factory support;
// they were test tokens). Their pools remain tradeable via the old router.
export const INCENTIFI_V4_FACTORY = String(
  import.meta.env.VITE_INCENTIFI_V4_FACTORY || '0x4166418Ceec501f6d4F6D1fb279d23e7fDD259d0'
).trim() as `0x${string}`;

export const INCENTIFI_V4_ROUTER = String(
  import.meta.env.VITE_INCENTIFI_V4_ROUTER || '0x762b4D9e514e4B19E54E99b62E7b731CE37FF1E6'
).trim() as `0x${string}`;

// The shared hook every V4-launched token's pool uses. Not a per-token
// contract (unlike the V3 bonding curve) — there is no "curve address" for a
// V4 token; its state lives in this hook's own curveStates(poolId) mapping.
export const INCENTIFI_V4_HOOK = String(
  import.meta.env.VITE_INCENTIFI_V4_HOOK || '0xC5Ef9Cb8c95cd8540E71b6D4c00a90257625a888'
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


// ----------------------------------------------------------------------------
// V4 "legible pool" trio (PR #17) — deployed on Robinhood Chain 2026-09-07, verified
// (hook + factory: Blockscout full match and Sourcify exact match; converter: Sourcify exact
// match), smoke-tested on mainnet (SMK95868). Every launched token is a REAL Uniswap V4 pool
// (one hook-owned range position, 2% dynamic LP fee) that generic terminals can index, traded
// through UniversalRouter + Permit2 like any other V4 pool, pre- AND post-graduation.
// Tokens on the older IncentifiV4HookGenericSell trio (INCENTIFI_V4_*) keep their own path;
// which trio a token belongs to is resolved PER TOKEN (src/lib/tokenVenue.ts), never globally.
// ----------------------------------------------------------------------------
export const INCENTIFI_LEGIBLE_HOOK = String(
  import.meta.env.VITE_INCENTIFI_LEGIBLE_HOOK || '0x921d0bE20A21e5A687734b4dF6302EA55BD168C0'
).trim() as `0x${string}`;

export const INCENTIFI_LEGIBLE_FACTORY = String(
  import.meta.env.VITE_INCENTIFI_LEGIBLE_FACTORY || '0xD4ce8F9577F3a865C3bA0c9d156f2b615df89Dda'
).trim() as `0x${string}`;

export const INCENTIFI_LEGIBLE_FEE_CONVERTER = String(
  import.meta.env.VITE_INCENTIFI_LEGIBLE_FEE_CONVERTER || '0xe1BB0667d64683072BaeE03D8D9Feb201dcAF7D9'
).trim() as `0x${string}`;

// Canonical Uniswap V4 infrastructure on Robinhood Chain (same PoolManager the hooks are bound to).
export const UNISWAP_V4_POOL_MANAGER = String(
  import.meta.env.VITE_UNISWAP_V4_POOL_MANAGER || '0x8366a39CC670B4001A1121B8F6A443A643e40951'
).trim() as `0x${string}`;

export const UNISWAP_V4_QUOTER = String(
  import.meta.env.VITE_UNISWAP_V4_QUOTER || '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94'
).trim() as `0x${string}`;

export const UNISWAP_V4_STATE_VIEW = String(
  import.meta.env.VITE_UNISWAP_V4_STATE_VIEW || '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'
).trim() as `0x${string}`;

/**
 * Feature flag for NEW launches only. `true` -> the launch page deploys through the legible
 * factory (`launchToken(token, address(0))`, ETH loss rewards). Anything else -> the previous
 * GenericSell launch path, unchanged. Existing tokens are never affected by this flag: they are
 * routed by the hook their pool actually uses (src/lib/tokenVenue.ts).
 */
export const LEGIBLE_LAUNCH_ENABLED =
  String(import.meta.env.VITE_LEGIBLE_LAUNCH_ENABLED || 'false').trim().toLowerCase() === 'true';

// ----------------------------------------------------------------------------
// LossRewardPoolV2 (PR #22) — creator-selected loss-reward payout asset. NOT deployed yet:
// there is deliberately NO fallback address. Every V2 code path is a no-op while this is unset
// (claims go to V1, badges read "ETH", the stock dropdown stays hidden).
// ----------------------------------------------------------------------------
export const LOSS_REWARD_POOL_V2 = String(import.meta.env.VITE_LOSS_REWARD_POOL_V2 || '').trim() as `0x${string}` | '';

/** Shows the real stock dropdown on the launch page (ETH / AAPL / TSLA / NVDA). Default off. */
export const STOCK_REWARDS_ENABLED =
  String(import.meta.env.VITE_STOCK_REWARDS_ENABLED || 'false').trim().toLowerCase() === 'true';

/** Robinhood's on-chain asset registry (StockFactory, UUPS proxy) — the canonical-token check. */
export const ROBINHOOD_STOCK_FACTORY = String(
  import.meta.env.VITE_ROBINHOOD_STOCK_FACTORY || '0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046'
).trim() as `0x${string}`;

/** Robinhood's public asset list (names, logos, ACTIVE status). Filtering only — the chain decides validity. */
export const ROBINHOOD_ASSETS_API_URL = String(
  import.meta.env.VITE_ROBINHOOD_ASSETS_API_URL || 'https://api.robinhood.com/rhj/assets'
).trim();
