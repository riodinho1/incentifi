import hardhatToolboxViemPlugin from '@nomicfoundation/hardhat-toolbox-viem';
import { defineConfig } from 'hardhat/config';

const ROBINHOOD_RPC_URL = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';

// Real Robinhood Chain mainnet — NOT the EDR-simulated fork above. Deliberately
// reads the signing key from an environment variable and NOTHING else: never a
// hardcoded default, never a fallback to a well-known test key (unlike a fork
// network, "no key configured" must mean "cannot send real transactions", not
// "silently signs with some other key"). If the env var is unset, `accounts`
// is an empty array and Hardhat will simply have no signer for this network —
// the correct failure mode, not a runtime crash mid-script.
const ROBINHOOD_MAINNET_PRIVATE_KEY = process.env.ROBINHOOD_MAINNET_PRIVATE_KEY;

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
        // Pinned for deterministic, reproducible test runs. IMPORTANT: the public
        // RPC endpoint does not appear to be a full archive node, and its
        // historical-state retention window is MUCH shorter than initially
        // assumed. Measured directly against the raw RPC (binary search on
        // eth_getBalance at decreasing block numbers, independent of any Hardhat
        // caching): queries succeeded down to ~5,000 blocks behind the live tip
        // and started failing with "metadata is not found" somewhere between
        // 5,000 and 8,000 blocks behind tip. Two earlier pins (53580647, then
        // 53817980) each worked initially and then failed later in the same
        // working session purely because enough wall-clock time (and therefore
        // real blocks) had passed for the pin to fall outside that window — this
        // is NOT a "set once, safe for days" value.
        //
        // Practical consequence: re-pin to within a few hundred blocks of the
        // CURRENT tip (query eth_blockNumber right before running) every time you
        // sit down to run these tests, and clear cache/edr-fork-cache after
        // re-pinning. A full run of the current suite takes well under a minute,
        // which comfortably fits inside the ~5,000-block window — the risk is
        // stale pins between sessions, not mid-run drift.
        blockNumber: 54178950,
      },
    },
    // Real Robinhood Chain mainnet (chain ID 4663). Every transaction sent
    // against this network is real, costs real gas, and is irreversible —
    // there is no fork, no snapshot, no reset. `accounts` is intentionally
    // populated ONLY from ROBINHOOD_MAINNET_PRIVATE_KEY; run any script
    // against this network with that variable set for that single command
    // only (e.g. `ROBINHOOD_MAINNET_PRIVATE_KEY=0x... npx hardhat run ... `),
    // never exported into a long-lived shell session and never committed to a
    // .env file.
    robinhoodMainnet: {
      type: 'http',
      chainType: 'l1',
      url: ROBINHOOD_RPC_URL,
      chainId: 4663,
      accounts: ROBINHOOD_MAINNET_PRIVATE_KEY ? [ROBINHOOD_MAINNET_PRIVATE_KEY] : [],
    },
  },
});
