import hardhatToolboxViemPlugin from '@nomicfoundation/hardhat-toolbox-viem';
import { defineConfig } from 'hardhat/config';

const ROBINHOOD_RPC_URL = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: '0.8.26',
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
        // Pinned for deterministic, reproducible test runs. Bump this if the real
        // Uniswap/WETH/LossRewardPool deployments at these addresses ever change.
        blockNumber: 53580647,
      },
    },
  },
});
