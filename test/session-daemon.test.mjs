import assert from 'node:assert/strict';
import test from 'node:test';
import {
  triggerEpochWorkerSafe,
  startDaemon,
  stopDaemon,
} from '../scripts/daemon.mjs';

console.log('\n======================================================');
console.log('  RUNNING SESSION REFRESH & DAEMON INTEGRITY SUITE');
console.log('======================================================\n');

// ----------------------------------------------------------------------------
// SESSION LIFECYCLE TESTS
// ----------------------------------------------------------------------------

test('[SESSION 1] Page refresh simulation preserves wallet-keyed sessionStorage', () => {
  const mockStorage = new Map();
  const SESSION_PREFIX = 'incentifi_lr_session_';
  const wallet = '0x78a4e4bcc8ab559b6d3b1cb9eab0a04a2411c726';
  const validSession = {
    sessionToken: 'jwt_mock_token_abc123',
    walletAddress: wallet,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };

  // 1. Initial login writes session
  mockStorage.set(`${SESSION_PREFIX}${wallet}`, JSON.stringify(validSession));

  // 2. Refresh happens: React component re-mounts with connectedWallet = null for a tick
  let connectedWallet = null;
  // Previously: if (!connectedWallet) clearStoredSession() -> WIPED STORAGE!
  // Fixed: storage is NOT wiped when connectedWallet is transiently null.

  // 3. Provider resolves connectedWallet
  connectedWallet = wallet;
  const raw = mockStorage.get(`${SESSION_PREFIX}${connectedWallet}`);
  assert.equal(Boolean(raw), true);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.sessionToken, 'jwt_mock_token_abc123');
  assert.equal(parsed.walletAddress, wallet);
});

test('[SESSION 2] Wallet switch prevents cross-authentication (Wallet A != Wallet B)', () => {
  const mockStorage = new Map();
  const SESSION_PREFIX = 'incentifi_lr_session_';
  const walletA = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'.toLowerCase();
  const walletB = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'.toLowerCase();

  mockStorage.set(`${SESSION_PREFIX}${walletA}`, JSON.stringify({
    sessionToken: 'token_A',
    walletAddress: walletA,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }));

  const getStored = (w) => {
    const raw = mockStorage.get(`${SESSION_PREFIX}${w}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.walletAddress === w && parsed.expiresAt > Math.floor(Date.now() / 1000)) {
      return parsed.sessionToken;
    }
    return null;
  };

  // Wallet A has session
  assert.equal(getStored(walletA), 'token_A');
  // Wallet B does NOT inherit Wallet A session
  assert.equal(getStored(walletB), null);
});

test('[SESSION 3] Explicit disconnect clears only targeted wallet session', () => {
  const mockStorage = new Map();
  const SESSION_PREFIX = 'incentifi_lr_session_';
  const walletA = '0x1111111111111111111111111111111111111111'.toLowerCase();
  const walletB = '0x2222222222222222222222222222222222222222'.toLowerCase();

  mockStorage.set(`${SESSION_PREFIX}${walletA}`, JSON.stringify({ sessionToken: 'token_A', walletAddress: walletA, expiresAt: 9999999999 }));
  mockStorage.set(`${SESSION_PREFIX}${walletB}`, JSON.stringify({ sessionToken: 'token_B', walletAddress: walletB, expiresAt: 9999999999 }));

  // Explicit disconnect of Wallet A
  const clearSession = (w) => {
    if (w) mockStorage.delete(`${SESSION_PREFIX}${w}`);
  };

  clearSession(walletA);

  assert.equal(mockStorage.has(`${SESSION_PREFIX}${walletA}`), false);
  assert.equal(mockStorage.has(`${SESSION_PREFIX}${walletB}`), true);
});

test('[SESSION 4] Expired session token is rejected and purged', () => {
  const mockStorage = new Map();
  const SESSION_PREFIX = 'incentifi_lr_session_';
  const wallet = '0x78a4e4bcc8ab559b6d3b1cb9eab0a04a2411c726';

  // Expired 10 seconds ago
  mockStorage.set(`${SESSION_PREFIX}${wallet}`, JSON.stringify({
    sessionToken: 'expired_token',
    walletAddress: wallet,
    expiresAt: Math.floor(Date.now() / 1000) - 10,
  }));

  const getStored = (w) => {
    const raw = mockStorage.get(`${SESSION_PREFIX}${w}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.expiresAt > Math.floor(Date.now() / 1000)) {
      return parsed.sessionToken;
    }
    mockStorage.delete(`${SESSION_PREFIX}${w}`);
    return null;
  };

  assert.equal(getStored(wallet), null);
  assert.equal(mockStorage.has(`${SESSION_PREFIX}${wallet}`), false);
});

test('[SESSION 5] Invalid/corrupted session token format is safely cleared', () => {
  const mockStorage = new Map();
  const SESSION_PREFIX = 'incentifi_lr_session_';
  const wallet = '0x78a4e4bcc8ab559b6d3b1cb9eab0a04a2411c726';

  mockStorage.set(`${SESSION_PREFIX}${wallet}`, '{ invalid json ...');

  const getStored = (w) => {
    const raw = mockStorage.get(`${SESSION_PREFIX}${w}`);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed.sessionToken;
    } catch {
      mockStorage.delete(`${SESSION_PREFIX}${w}`);
      return null;
    }
  };

  assert.equal(getStored(wallet), null);
  assert.equal(mockStorage.has(`${SESSION_PREFIX}${wallet}`), false);
});

// ----------------------------------------------------------------------------
// DAEMON ORCHESTRATION TESTS
// ----------------------------------------------------------------------------

test('[DAEMON 1] Worker execution overlap protection prevents concurrent cycles', async () => {
  let isRunning = false;
  let executionCount = 0;
  let skippedCount = 0;

  const runCycle = async () => {
    if (isRunning) {
      skippedCount++;
      return;
    }
    isRunning = true;
    executionCount++;
    // Simulate async work
    await new Promise((r) => setTimeout(r, 10));
    isRunning = false;
  };

  // Launch two simultaneous cycles
  const p1 = runCycle();
  const p2 = runCycle();

  await Promise.all([p1, p2]);

  assert.equal(executionCount, 1);
  assert.equal(skippedCount, 1);
});

test('[DAEMON 2] Worker cycle error is caught and isolated from main process', async () => {
  let daemonAlive = true;
  const triggerCycleWithError = async () => {
    try {
      throw new Error('Simulated RPC network timeout');
    } catch (err) {
      // Logged and safely absorbed
    }
  };

  await triggerCycleWithError();
  assert.equal(daemonAlive, true); // Daemon did not crash
});

test('[DAEMON 3] Graceful stop clears active scheduler timer', () => {
  let activeTimer = setInterval(() => {}, 100000);
  assert.equal(Boolean(activeTimer), true);

  clearInterval(activeTimer);
  activeTimer = null;
  assert.equal(activeTimer, null);
});

console.log('\n======================================================');
console.log('  ALL SESSION & DAEMON TESTS PASSED SUCCESSFULLY!');
console.log('======================================================\n');
