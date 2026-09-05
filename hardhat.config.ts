import hardhatToolboxViemPlugin from '@nomicfoundation/hardhat-toolbox-viem';
import { defineConfig } from 'hardhat/config';

const ROBINHOOD_RPC_URL = process.env.ROBINHOOD_RPC_URL || process.env.VITE_EVM_RPC_URL || process.env.EVM_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';

// Real mainnet deployer key — deliberately NOT read at module scope with a fallback,
// so that a missing key produces an empty `accounts` array (a clear Hardhat
// "no accounts configured" error on first transaction) rather than silently
// defaulting to some other value. scripts/deploy-v3-fixed-factory-and-router.ts and
// scripts/verify-v3-fix-mainnet.ts independently re-check for this env var themselves
// before doing anything, with a clearer error message.
const rawDeployerKey = (process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY || '').trim();
const DEPLOYER_ACCOUNTS = rawDeployerKey
  ? [rawDeployerKey.startsWith('0x') ? rawDeployerKey : `0x${rawDeployerKey}`]
  : [];

// The pinned fork block MUST be recent: this RPC's `eth_getBalance`/etc. at a historical
// block reply with "metadata is not found" once that block falls out of its retention
// window — empirically measured (binary search against real responses) at only ~5,600-
// 6,000 blocks behind head, NOT a true archive node. A block number hardcoded at any
// single point in time will therefore silently go stale and break every fork test within
// roughly an hour of wall-clock time (block time here is a few seconds). Resolved
// dynamically at config-load time instead, with a safety margin comfortably inside that
// window so a slow test run doesn't itself walk past the boundary.
const FORK_BLOCK_SAFETY_MARGIN = 500;
async function resolveRecentForkBlock(): Promise<number> {
  const override = process.env.ROBINHOOD_FORK_BLOCK_NUMBER;
  if (override) return Number(override);
  try {
    const res = await fetch(ROBINHOOD_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    });
    const json = (await res.json()) as { result?: string };
    if (!json.result) throw new Error('no result in eth_blockNumber response');
    return Number(BigInt(json.result)) - FORK_BLOCK_SAFETY_MARGIN;
  } catch (err) {
    console.warn(
      `[hardhat.config] Could not fetch a fresh fork block number (${err instanceof Error ? err.message : err}); ` +
        'falling back to a hardcoded block that may already be outside the RPC\'s retention window.'
    );
    return 53580647;
  }
}
const RESOLVED_FORK_BLOCK_NUMBER = await resolveRecentForkBlock();

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    version: '0.8.26',
    settings: {
      // viaIR needed for IncentifiV4Hook.sol's _graduate() — its real V4
      // liquidity-deposit logic (bootstrap mint + corrective swap + final mint,
      // each with its own BalanceDelta unpacking) hits "stack too deep" under
      // the legacy codegen pipeline even with optimizer runs tuned; viaIR's
      // separate stack-allocation pass resolves it without artificially
      // splitting that logic across more functions than the design calls for.
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
    },
  },
  paths: {
    // Scoped away from test/*.mjs (this repo's plain-node JS suite, run via `npm test`)
    // so Hardhat's node:test runner only ever picks up test/hardhat/**.
    tests: { nodejs: 'test/hardhat' },
  },
  networks: {
    robinhoodFork: {
      type: 'edr-simulated',
      chainType: 'l1',
      forking: {
        url: ROBINHOOD_RPC_URL,
        // Resolved dynamically above (recent block, minus a safety margin) — see
        // resolveRecentForkBlock()'s comment for why a hardcoded pin doesn't stay valid.
        blockNumber: RESOLVED_FORK_BLOCK_NUMBER,
      },
    },
    // REAL Robinhood Chain mainnet — used only by scripts/deploy-v3-fixed-factory-and-router.ts
    // and scripts/verify-v3-fix-mainnet.ts. Transactions here are real and cost real ETH.
    robinhoodMainnet: {
      type: 'http',
      chainType: 'l1',
      url: ROBINHOOD_RPC_URL,
      chainId: 4663,
      accounts: DEPLOYER_ACCOUNTS,
    },
  },
});
