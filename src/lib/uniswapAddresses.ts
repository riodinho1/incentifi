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

export const INCENTIFI_SWAP_ROUTER = String(
  import.meta.env.VITE_INCENTIFI_SWAP_ROUTER || '0x323326127170135c36384C694c9657cE8f5e135D'
).trim() as `0x${string}`;

export const LOSS_REWARD_POOL = String(
  import.meta.env.VITE_LOSS_REWARD_POOL || '0x17b3C4b8b6D254c46E13670f5e13B6F960589a1B'
).trim() as `0x${string}`;

export const WETH_ADDRESS = String(
  import.meta.env.VITE_WETH_ADDRESS || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'
).trim() as `0x${string}`;

// Standard EVM burn address - tokens/NFTs sent here can never be moved again.
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const;

// 1% fee tier (matches how comparable Robinhood Chain launchpads seed new-token pools).
export const POOL_FEE = 10_000;

// 1.0% Creator Trading Fee (50% Creator / 50% Loss Reward Pool)
export const CREATOR_FEE_BPS = 100;

// Full-range ticks for the 1% fee tier (tick spacing 200).
export const TICK_LOWER = -887_200;
export const TICK_UPPER = 887_200;

