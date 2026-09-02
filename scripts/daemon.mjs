import { runIndexer } from './evm-indexer.mjs';
import { runEpochWorker, SNAPSHOT_INTERVAL_SECONDS } from './loss-reward-worker.mjs';
import fs from 'fs';

// ============================================================================
// INCENTIFI PRODUCTION DAEMON
// Orchestrates continuous EVM Indexer (10s) and Loss-Reward Worker (5m)
// ============================================================================

// Robust .env.local loader (safe, non-printing)
if (fs.existsSync('.env.local')) {
  const envContent = fs.readFileSync('.env.local', 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [k, ...v] = line.split('=');
    const keyName = k.trim();
    let val = v.join('=').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (keyName && val.length > 0) {
      process.env[keyName] = val;
    }
  }
}

const RPC_URL = process.env.VITE_EVM_RPC_URL || process.env.EVM_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const OPERATOR_CONFIGURED = Boolean(process.env.OPERATOR_PRIVATE_KEY);
const LOSS_REWARD_INTERVAL_MS = (SNAPSHOT_INTERVAL_SECONDS || 300) * 1000;

console.log('\n======================================================');
console.log('  INCENTIFI UNIFIED BACKEND DAEMON STARTING');
console.log('======================================================');
console.log(`[DAEMON] Time:                ${new Date().toISOString()}`);
console.log(`[DAEMON] RPC URL:             ${RPC_URL}`);
console.log(`[DAEMON] Supabase:            ${SUPABASE_URL ? 'Configured' : 'Missing'}`);
console.log(`[DAEMON] Service Role Key:    ${SUPABASE_KEY ? 'Present' : 'Missing'}`);
console.log(`[DAEMON] Operator Key:        ${OPERATOR_CONFIGURED ? 'Present' : 'Not configured (Simulation/Dry-Run only)'}`);
console.log(`[DAEMON] Indexer Cadence:     ~10 seconds`);
console.log(`[DAEMON] LossReward Cadence:  ${LOSS_REWARD_INTERVAL_MS / 1000} seconds (${LOSS_REWARD_INTERVAL_MS / 60000} mins)`);
console.log('======================================================\n');

let isEpochWorkerRunning = false;
let epochIntervalHandle = null;
let isShuttingDown = false;

/**
 * Triggers an epoch worker run safely with overlap prevention
 */
export async function triggerEpochWorkerSafe(options = {}) {
  if (isShuttingDown) return;
  if (isEpochWorkerRunning) {
    console.warn(`[DAEMON WARNING] Previous epoch worker execution is still active. Skipping this cycle to prevent concurrency conflicts.`);
    return;
  }

  isEpochWorkerRunning = true;
  try {
    console.log(`\n[DAEMON] [${new Date().toISOString()}] Initiating 5-minute Loss-Reward epoch evaluation cycle...`);
    const results = await runEpochWorker(options);
    console.log(`[DAEMON] [${new Date().toISOString()}] Loss-Reward evaluation cycle completed. Processed ${results?.length || 0} tokens.\n`);
  } catch (err) {
    console.error(`[DAEMON ERROR] Loss-Reward worker cycle failed: ${err.message}`);
    // Error is logged and caught so indexer continues running smoothly
  } finally {
    isEpochWorkerRunning = false;
  }
}

/**
 * Starts the unified daemon
 */
export function startDaemon(options = {}) {
  // 1. Start EVM Indexer
  console.log('[DAEMON] Starting EVM block and trade indexer...');
  runIndexer();

  // 2. Schedule 5-minute Loss-Reward Worker
  console.log(`[DAEMON] Scheduling Loss-Reward worker every ${LOSS_REWARD_INTERVAL_MS / 1000}s...`);
  epochIntervalHandle = setInterval(() => {
    triggerEpochWorkerSafe(options);
  }, LOSS_REWARD_INTERVAL_MS);

  console.log('[DAEMON] All background services initialized and running successfully.\n');
}

/**
 * Graceful shutdown handler
 */
export function stopDaemon() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\n[DAEMON] Graceful shutdown initiated. Stopping timers...');
  if (epochIntervalHandle) {
    clearInterval(epochIntervalHandle);
    epochIntervalHandle = null;
  }
  console.log('[DAEMON] Timers stopped. Exiting cleanly.');
}

process.on('SIGINT', () => {
  stopDaemon();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopDaemon();
  process.exit(0);
});

if (process.argv[1]?.endsWith('daemon.mjs')) {
  const isDryRun = process.argv.includes('--dry-run');
  startDaemon({ dryRun: isDryRun });
}
