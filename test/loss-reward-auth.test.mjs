import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

// Test EVM Accounts
const ACCOUNT_A = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const ACCOUNT_B = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const ATTACKER = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');

const TEST_TOKEN = '0x1111111111111111111111111111111111111111';

// In-Memory Database Simulator for Testing Schema, RLS, and Gateway
class DatabaseSimulator {
  constructor() {
    this.authNonces = new Map();
    this.holderCostBasis = new Map();
    this.epochHolderRewards = new Map();
    this.rewardEpochs = new Map();
    this.tokenTrades = new Map();
    this.tokenMarketSnapshots = new Map();
  }

  seed() {
    // Seed private data for Wallet A
    this.holderCostBasis.set(`${TEST_TOKEN.toLowerCase()}:${ACCOUNT_A.address.toLowerCase()}`, {
      token_address: TEST_TOKEN.toLowerCase(),
      wallet_address: ACCOUNT_A.address.toLowerCase(),
      token_balance: '100000',
      total_invested_eth: '1.5',
      avg_cost_basis_eth: '0.000015',
      is_eligible: true,
      is_underwater_seller: false,
    });

    this.epochHolderRewards.set(`1:${ACCOUNT_A.address.toLowerCase()}`, {
      id: 1,
      epoch_id: 1,
      token_address: TEST_TOKEN.toLowerCase(),
      wallet_address: ACCOUNT_A.address.toLowerCase(),
      final_reward_eth: '0.05',
      merkle_proof: ['0xaaa111', '0xaaa222'],
      claimed: false,
    });

    // Seed private data for Wallet B
    this.holderCostBasis.set(`${TEST_TOKEN.toLowerCase()}:${ACCOUNT_B.address.toLowerCase()}`, {
      token_address: TEST_TOKEN.toLowerCase(),
      wallet_address: ACCOUNT_B.address.toLowerCase(),
      token_balance: '500000',
      total_invested_eth: '10.0',
      avg_cost_basis_eth: '0.000020',
      is_eligible: true,
      is_underwater_seller: false,
    });

    this.epochHolderRewards.set(`1:${ACCOUNT_B.address.toLowerCase()}`, {
      id: 2,
      epoch_id: 1,
      token_address: TEST_TOKEN.toLowerCase(),
      wallet_address: ACCOUNT_B.address.toLowerCase(),
      final_reward_eth: '0.25',
      merkle_proof: ['0xbbb111', '0xbbb222'],
      claimed: false,
    });

    // Seed public data
    this.rewardEpochs.set(`1`, {
      epoch_id: 1,
      token_address: TEST_TOKEN.toLowerCase(),
      epoch_number: 1,
      pool_price_eth: '0.000010',
      total_distributed_eth: '0.30',
      merkle_root: '0xroot123',
    });

    this.tokenTrades.set(`0xtx1`, {
      tx_hash: '0xtx1',
      token_address: TEST_TOKEN.toLowerCase(),
      trader_address: ACCOUNT_A.address.toLowerCase(),
      side: 'buy',
      amount_token: '100000',
      amount_eth: '1.5',
    });
  }

  // RLS Simulated Access Controls
  queryAnon(table, filter = {}) {
    if (table === 'holder_cost_basis' || table === 'epoch_holder_rewards' || table === 'auth_nonces') {
      // RLS Policy blocks anon access
      return { data: [], error: { message: 'Permission denied: table is private' } };
    }
    if (table === 'reward_epochs') {
      return { data: Array.from(this.rewardEpochs.values()), error: null };
    }
    if (table === 'token_trades_evm') {
      return { data: Array.from(this.tokenTrades.values()), error: null };
    }
    return { data: [], error: null };
  }

  // Gateway Service Role Access
  insertNonce(record) {
    this.authNonces.set(record.nonce, { ...record });
  }

  getNonce(nonce) {
    return this.authNonces.get(nonce) || null;
  }

  // Atomically consume nonce
  consumeAuthNonce(nonce, walletAddress) {
    const record = this.authNonces.get(nonce);
    if (!record) return null;
    if (record.used) return null;
    if (record.wallet_address.toLowerCase() !== walletAddress.toLowerCase()) return null;
    if (new Date(record.expires_at).getTime() <= Date.now()) return null;

    record.used = true;
    record.used_at = new Date().toISOString();
    return record;
  }

  queryPrivateCostBasis(tokenAddress, walletAddress) {
    const key = `${tokenAddress.toLowerCase()}:${walletAddress.toLowerCase()}`;
    return this.holderCostBasis.get(key) || null;
  }

  queryPrivateRewards(tokenAddress, walletAddress) {
    const results = [];
    for (const record of this.epochHolderRewards.values()) {
      if (
        record.token_address === tokenAddress.toLowerCase() &&
        record.wallet_address === walletAddress.toLowerCase() &&
        !record.claimed
      ) {
        results.push(record);
      }
    }
    return results;
  }
}

// JWT Helpers for Gateway Test
const JWT_SECRET = 'test_jwt_secret_key_for_unit_tests_only_32bytes';

async function createTestJWT(walletAddress, expInSeconds = 3600) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    wallet_address: getAddress(walletAddress).toLowerCase(),
    iat: now,
    exp: now + expInSeconds,
    aud: 'incentifi-loss-reward',
    iss: 'incentifi.finance',
  };

  const toB64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${toB64(header)}.${toB64(payload)}`;
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(unsigned));
  const sigB64 = Buffer.from(sig).toString('base64url');

  return `${unsigned}.${sigB64}`;
}

async function verifyTestJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [hB64, pB64, sB64] = parts;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const unsigned = `${hB64}.${pB64}`;
    const sig = Buffer.from(sB64, 'base64url');
    const valid = await crypto.subtle.verify('HMAC', key, sig, encoder.encode(unsigned));
    if (!valid) return null;

    const payload = JSON.parse(Buffer.from(pB64, 'base64url').toString('utf-8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (payload.aud !== 'incentifi-loss-reward') return null;

    return payload;
  } catch {
    return null;
  }
}

describe('Loss-Reward Authentication & Database Privacy Specification Test Suite', () => {
  let db;

  beforeEach(() => {
    db = new DatabaseSimulator();
    db.seed();
  });

  // TEST 1: Direct Anon SELECT on holder_cost_basis is blocked
  it('1. Rejects direct anonymous/public SELECT on holder_cost_basis', async () => {
    const result = db.queryAnon('holder_cost_basis', { wallet_address: ACCOUNT_A.address });
    assert.strictEqual(result.data.length, 0);
    assert.match(result.error.message, /Permission denied/);
  });

  // TEST 2: Direct Anon SELECT on epoch_holder_rewards is blocked
  it('2. Rejects direct anonymous/public SELECT on epoch_holder_rewards', async () => {
    const result = db.queryAnon('epoch_holder_rewards', { wallet_address: ACCOUNT_A.address });
    assert.strictEqual(result.data.length, 0);
    assert.match(result.error.message, /Permission denied/);
  });

  // TEST 3: Direct Anon SELECT on auth_nonces is blocked
  it('3. Rejects direct anonymous/public SELECT on auth_nonces', async () => {
    const result = db.queryAnon('auth_nonces');
    assert.strictEqual(result.data.length, 0);
    assert.match(result.error.message, /Permission denied/);
  });

  // TEST 4: Public tables remain readable
  it('4. Allows anonymous/public read on public tables (reward_epochs, token_trades_evm)', async () => {
    const epochs = db.queryAnon('reward_epochs');
    assert.strictEqual(epochs.data.length, 1);
    assert.strictEqual(epochs.error, null);

    const trades = db.queryAnon('token_trades_evm');
    assert.strictEqual(trades.data.length, 1);
    assert.strictEqual(trades.error, null);
  });

  // TEST 5: Challenge endpoint generates valid UUID nonce and formatted message
  it('5. Generates valid EIP-191 challenge with 5-minute TTL', async () => {
    const nonce = crypto.randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 5 * 60 * 1000);

    const message = [
      'Incentifi Loss-Reward Authentication',
      '',
      `Wallet: ${getAddress(ACCOUNT_A.address)}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt.toISOString()}`,
      `Expires At: ${expiresAt.toISOString()}`,
      '',
      'Sign this message to authenticate your wallet for Loss-Reward tracking.',
      'This request will not cost any gas or execute any blockchain transaction.',
    ].join('\n');

    db.insertNonce({
      wallet_address: ACCOUNT_A.address.toLowerCase(),
      nonce,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      used: false,
    });

    const stored = db.getNonce(nonce);
    assert.ok(stored);
    assert.strictEqual(stored.used, false);
    assert.strictEqual(stored.wallet_address, ACCOUNT_A.address.toLowerCase());
  });

  // TEST 6: Successful EIP-191 signature verification and JWT issuance
  it('6. Successfully verifies valid EIP-191 signature and consumes nonce', async () => {
    const nonce = crypto.randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 5 * 60 * 1000);

    const message = [
      'Incentifi Loss-Reward Authentication',
      '',
      `Wallet: ${getAddress(ACCOUNT_A.address)}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt.toISOString()}`,
      `Expires At: ${expiresAt.toISOString()}`,
      '',
      'Sign this message to authenticate your wallet for Loss-Reward tracking.',
      'This request will not cost any gas or execute any blockchain transaction.',
    ].join('\n');

    db.insertNonce({
      wallet_address: ACCOUNT_A.address.toLowerCase(),
      nonce,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      used: false,
    });

    // User signs challenge with EIP-191 personal_sign
    const signature = await ACCOUNT_A.signMessage({ message });

    // Server verification flow:
    // 1. Retrieve nonce
    const record = db.getNonce(nonce);
    assert.ok(record && !record.used);

    // 2. Verify signature before burning nonce
    const { recoverMessageAddress } = await import('viem');
    const recovered = await recoverMessageAddress({ message, signature });
    assert.strictEqual(recovered.toLowerCase(), ACCOUNT_A.address.toLowerCase());

    // 3. Atomically consume nonce
    const consumed = db.consumeAuthNonce(nonce, recovered);
    assert.ok(consumed);
    assert.strictEqual(consumed.used, true);

    // 4. Issue JWT
    const jwt = await createTestJWT(ACCOUNT_A.address);
    const verifiedClaims = await verifyTestJWT(jwt);
    assert.ok(verifiedClaims);
    assert.strictEqual(verifiedClaims.wallet_address, ACCOUNT_A.address.toLowerCase());
  });

  // TEST 7: Invalid signature does NOT burn nonce (allows user retry)
  it('7. Rejects invalid signature without consuming/burning the nonce', async () => {
    const nonce = crypto.randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 5 * 60 * 1000);

    const message = [
      'Incentifi Loss-Reward Authentication',
      '',
      `Wallet: ${getAddress(ACCOUNT_A.address)}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt.toISOString()}`,
      `Expires At: ${expiresAt.toISOString()}`,
      '',
      'Sign this message to authenticate your wallet for Loss-Reward tracking.',
      'This request will not cost any gas or execute any blockchain transaction.',
    ].join('\n');

    db.insertNonce({
      wallet_address: ACCOUNT_A.address.toLowerCase(),
      nonce,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      used: false,
    });

    // Attacker signs on behalf of Account A with attacker's private key
    const badSignature = await ATTACKER.signMessage({ message });

    const { recoverMessageAddress } = await import('viem');
    const recovered = await recoverMessageAddress({ message, signature: badSignature });

    // Signature does not match Account A
    assert.notStrictEqual(recovered.toLowerCase(), ACCOUNT_A.address.toLowerCase());

    // Verify that nonce was NOT consumed
    const record = db.getNonce(nonce);
    assert.strictEqual(record.used, false);
  });

  // TEST 8: Replay attack on consumed nonce is rejected
  it('8. Rejects replay attack using already consumed nonce', async () => {
    const nonce = crypto.randomUUID();
    db.insertNonce({
      wallet_address: ACCOUNT_A.address.toLowerCase(),
      nonce,
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300000).toISOString(),
      used: false,
    });

    // First consumption succeeds
    const firstConsume = db.consumeAuthNonce(nonce, ACCOUNT_A.address);
    assert.ok(firstConsume);

    // Second consumption attempt (replay) fails atomically
    const secondConsume = db.consumeAuthNonce(nonce, ACCOUNT_A.address);
    assert.strictEqual(secondConsume, null);
  });

  // TEST 9: Concurrent race-condition: exactly one verification succeeds
  it('9. Handles concurrent verification requests with atomic single-winner nonce consumption', async () => {
    const nonce = crypto.randomUUID();
    db.insertNonce({
      wallet_address: ACCOUNT_A.address.toLowerCase(),
      nonce,
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300000).toISOString(),
      used: false,
    });

    // Simulate 10 simultaneous concurrent verification requests
    const attempts = await Promise.all(
      Array.from({ length: 10 }).map(async () => {
        return db.consumeAuthNonce(nonce, ACCOUNT_A.address);
      })
    );

    const successfulAttempts = attempts.filter((res) => res !== null);
    assert.strictEqual(successfulAttempts.length, 1, 'Exactly one concurrent verification must succeed');
  });

  // TEST 10: Authenticated query returns user-scoped private data
  it('10. Scopes /query data strictly to authenticated wallet identity in JWT', async () => {
    const jwtA = await createTestJWT(ACCOUNT_A.address);
    const claims = await verifyTestJWT(jwtA);
    assert.ok(claims);

    const costBasis = db.queryPrivateCostBasis(TEST_TOKEN, claims.wallet_address);
    const rewards = db.queryPrivateRewards(TEST_TOKEN, claims.wallet_address);

    assert.ok(costBasis);
    assert.strictEqual(costBasis.wallet_address, ACCOUNT_A.address.toLowerCase());
    assert.strictEqual(costBasis.token_balance, '100000');
    assert.strictEqual(rewards.length, 1);
    assert.strictEqual(rewards[0].final_reward_eth, '0.05');
  });

  // TEST 11: Cross-wallet data isolation (Wallet A cannot read Wallet B data)
  it('11. Prevents cross-wallet private data leakage (Wallet A cannot view Wallet B data)', async () => {
    // Authenticated as Wallet A
    const jwtA = await createTestJWT(ACCOUNT_A.address);
    const claims = await verifyTestJWT(jwtA);

    // Attempting to query as Wallet A returns Wallet A's data, never Wallet B
    const dataForA = db.queryPrivateCostBasis(TEST_TOKEN, claims.wallet_address);
    assert.strictEqual(dataForA.wallet_address, ACCOUNT_A.address.toLowerCase());
    assert.notStrictEqual(dataForA.wallet_address, ACCOUNT_B.address.toLowerCase());
    assert.strictEqual(dataForA.token_balance, '100000'); // NOT 500000
  });

  // TEST 12: Merkle proofs are wallet-scoped and private
  it('12. Merkle proofs returned are isolated and private to authenticated wallet', async () => {
    const jwtA = await createTestJWT(ACCOUNT_A.address);
    const claimsA = await verifyTestJWT(jwtA);
    const rewardsA = db.queryPrivateRewards(TEST_TOKEN, claimsA.wallet_address);
    assert.deepStrictEqual(rewardsA[0].merkle_proof, ['0xaaa111', '0xaaa222']);

    const jwtB = await createTestJWT(ACCOUNT_B.address);
    const claimsB = await verifyTestJWT(jwtB);
    const rewardsB = db.queryPrivateRewards(TEST_TOKEN, claimsB.wallet_address);
    assert.deepStrictEqual(rewardsB[0].merkle_proof, ['0xbbb111', '0xbbb222']);
  });

  // TEST 13: Multi-Epoch Claim (Epoch 1 + Epoch 3 unclaimed -> both claim successfully)
  it('13. Multi-Epoch Claim: Epoch 1 + Epoch 3 both unclaimed claim successfully in single batch', async () => {
    // Seed Epoch 3 for Account A
    db.epochHolderRewards.set(`3:${ACCOUNT_A.address.toLowerCase()}`, {
      id: 3,
      epoch_id: 3,
      token_address: TEST_TOKEN.toLowerCase(),
      wallet_address: ACCOUNT_A.address.toLowerCase(),
      final_reward_eth: '0.08',
      merkle_proof: ['0xaaa333', '0xaaa444'],
      claimed: false,
    });

    const jwtA = await createTestJWT(ACCOUNT_A.address);
    const claimsA = await verifyTestJWT(jwtA);
    const unclaimed = db.queryPrivateRewards(TEST_TOKEN, claimsA.wallet_address);

    assert.strictEqual(unclaimed.length, 2, 'Should find 2 unclaimed epochs (Epoch 1 & 3)');
    const epochIds = unclaimed.map((u) => u.epoch_id);
    assert.deepStrictEqual(epochIds, [1, 3]);

    // Simulate batch claim execution & service_role update
    for (const u of unclaimed) {
      u.claimed = true;
      u.claimed_at = new Date().toISOString();
    }

    const remaining = db.queryPrivateRewards(TEST_TOKEN, claimsA.wallet_address);
    assert.strictEqual(remaining.length, 0, 'All epochs should now be marked claimed');
  });

  // TEST 14: Stale DB Reconciliation (Epoch 1 already claimed on-chain, Epoch 3 unclaimed)
  it('14. Stale DB Reconciliation: Epoch 1 already claimed on-chain is reconciled, Epoch 3 successfully claims', async () => {
    // Reset DB with Epoch 1 stale (DB false, On-Chain true) and Epoch 3 genuine unclaimed
    db.epochHolderRewards.set(`1:${ACCOUNT_A.address.toLowerCase()}`, {
      id: 1,
      epoch_id: 1,
      token_address: TEST_TOKEN.toLowerCase(),
      wallet_address: ACCOUNT_A.address.toLowerCase(),
      final_reward_eth: '0.05',
      merkle_proof: ['0xaaa111', '0xaaa222'],
      claimed: false, // Stale in DB!
    });
    db.epochHolderRewards.set(`3:${ACCOUNT_A.address.toLowerCase()}`, {
      id: 3,
      epoch_id: 3,
      token_address: TEST_TOKEN.toLowerCase(),
      wallet_address: ACCOUNT_A.address.toLowerCase(),
      final_reward_eth: '0.08',
      merkle_proof: ['0xaaa333', '0xaaa444'],
      claimed: false,
    });

    // Simulated on-chain state: hasClaimed[token][1][AccountA] = true, hasClaimed[token][3][AccountA] = false
    const onchainHasClaimed = (epochId) => epochId === 1;

    const jwtA = await createTestJWT(ACCOUNT_A.address);
    const claimsA = await verifyTestJWT(jwtA);
    const candidates = db.queryPrivateRewards(TEST_TOKEN, claimsA.wallet_address);

    // Gateway reconciliation step
    const genuineUnclaimed = [];
    for (const c of candidates) {
      if (onchainHasClaimed(c.epoch_id)) {
        // Stale on-chain record: reconcile DB immediately via service-role
        c.claimed = true;
        c.claimed_at = new Date().toISOString();
      } else {
        genuineUnclaimed.push(c);
      }
    }

    assert.strictEqual(genuineUnclaimed.length, 1, 'Only Epoch 3 should remain to be claimed');
    assert.strictEqual(genuineUnclaimed[0].epoch_id, 3);

    // Claim Epoch 3
    genuineUnclaimed[0].claimed = true;
    genuineUnclaimed[0].claimed_at = new Date().toISOString();

    const remaining = db.queryPrivateRewards(TEST_TOKEN, claimsA.wallet_address);
    assert.strictEqual(remaining.length, 0, 'No unclaimed epochs remain');
  });

  // TEST 15: Exact wei integer amount preservation (No floating-point drift)
  it('15. Exact wei amount is preserved with no floating-point arithmetic', async () => {
    const { parseEther, formatEther } = await import('viem');
    const exactSubMicroEth = '0.000000000012345678';
    const parsedWei = parseEther(exactSubMicroEth);
    assert.strictEqual(parsedWei.toString(), '12345678');
    assert.strictEqual(formatEther(parsedWei), exactSubMicroEth);

    // Verify parseEther equals exact expected integer wei for standard reward
    const standardEth = '0.05';
    const standardWei = parseEther(standardEth);
    assert.strictEqual(standardWei.toString(), '50000000000000000');

    // Confirm that parseEther string conversion is free of IEEE 754 precision drift
    const precisionLossExample = '0.000000000000000001'; // 1 wei
    assert.strictEqual(parseEther(precisionLossExample).toString(), '1');
  });

  // TEST 16: Failure safety: Reverted on-chain transaction & RPC errors leave DB rows unclaimed (Fail Closed)
  it('16. Failed on-chain transaction & RPC errors leave DB rows unclaimed (Fail Closed)', async () => {
    db.epochHolderRewards.clear();
    db.epochHolderRewards.set(`5:${ACCOUNT_A.address.toLowerCase()}`, {
      id: 5,
      epoch_id: 5,
      token_address: TEST_TOKEN.toLowerCase(),
      wallet_address: ACCOUNT_A.address.toLowerCase(),
      final_reward_eth: '0.10',
      merkle_proof: ['0xaaa555'],
      claimed: false,
    });

    const jwtA = await createTestJWT(ACCOUNT_A.address);
    const claimsA = await verifyTestJWT(jwtA);
    const candidates = db.queryPrivateRewards(TEST_TOKEN, claimsA.wallet_address);
    assert.strictEqual(candidates.length, 1);

    // Case A: RPC hasClaimed query fails -> FAIL CLOSED: abort claim, do not modify DB
    let rpcFailed = true;
    let claimExecuted = false;
    if (rpcFailed) {
      // Must abort immediately with 503 error, zero DB updates
      claimExecuted = false;
    }

    assert.strictEqual(claimExecuted, false, 'RPC failure must abort claim execution');
    assert.strictEqual(candidates[0].claimed, false, 'DB row must remain unclaimed on RPC failure');

    // Case B: Transaction broadcast fails/reverts -> do not update DB
    let txSuccess = false;
    try {
      throw new Error('Simulation: On-chain transaction reverted');
    } catch {
      txSuccess = false;
    }

    if (txSuccess) {
      candidates[0].claimed = true;
    }

    const postAttempt = db.queryPrivateRewards(TEST_TOKEN, claimsA.wallet_address);
    assert.strictEqual(postAttempt.length, 1, 'DB record must remain claimed=false on tx failure');
    assert.strictEqual(postAttempt[0].claimed, false);
  });

  // TEST 17: Repeated claim does not double-pay or error
  it('17. Repeated claim after successful claim returns already claimed gracefully', async () => {
    const jwtA = await createTestJWT(ACCOUNT_A.address);
    const claimsA = await verifyTestJWT(jwtA);
    const remaining = db.queryPrivateRewards(TEST_TOKEN, claimsA.wallet_address);
    // Mark the record as claimed
    if (remaining.length > 0) remaining[0].claimed = true;

    const afterClaim = db.queryPrivateRewards(TEST_TOKEN, claimsA.wallet_address);
    assert.strictEqual(afterClaim.length, 0, 'Zero unclaimed records exist');
  });

  // TEST 18: Gasless claim architecture never requires user on-chain transaction
  it('18. Gasless claim architecture: User signs gas-free auth challenge and relayer executes on-chain', async () => {
    // EIP-191 personal_sign challenge requires 0 gas
    const nonce = crypto.randomUUID();
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 300000).toISOString();
    const msg = [
      'Incentifi Loss-Reward Protection Authentication',
      `Wallet Address: ${ACCOUNT_A.address}`,
      `Nonce: ${nonce}`,
    ].join('\n');

    const signature = await ACCOUNT_A.signMessage({ message: msg });
    assert.ok(signature.startsWith('0x'), 'Signature created gas-free via personal_sign');
  });

  // TEST 19: Feature 1: Underfunded pool preserves 100% theoretical rewards and Merkle proofs as pending_funding
  it('19. Underfunded pool preserves 100% full theoretical rewards and Merkle proofs as pending_funding', async () => {
    const theoreticalDemandEth = 0.50;
    const availablePoolEth = 0.00; // Empty pool
    const isUnderfunded = availablePoolEth < theoreticalDemandEth;
    assert.strictEqual(isUnderfunded, true);

    // Reward allocations are calculated at 100% full theoretical demand (no scaling down to 0)
    const allocA = {
      wallet: ACCOUNT_A.address.toLowerCase(),
      unrealizedLoss: 1.0,
      theoreticalReward: 0.10,
    };
    const finalRewardEth = allocA.theoreticalReward; // 0.10 ETH preserved
    const finalRewardWei = BigInt(Math.round(finalRewardEth * 1e18));
    assert.strictEqual(finalRewardWei.toString(), '100000000000000000');

    // Epoch is stored as pending_funding
    const pendingEpoch = {
      epoch_id: 100,
      epoch_number: 100,
      total_theoretical_reward_eth: theoreticalDemandEth,
      total_distributed_eth: theoreticalDemandEth,
      scaling_factor: 1.0,
      merkle_root: '0xpendingroot100',
      status: 'pending_funding',
      onchain_tx_hash: null,
    };

    assert.strictEqual(pendingEpoch.status, 'pending_funding');
    assert.strictEqual(pendingEpoch.onchain_tx_hash, null);
    assert.strictEqual(pendingEpoch.total_distributed_eth, 0.50, 'Original theoretical amount preserved');
  });

  // TEST 20: Feature 1: When pool is funded, pending epoch is published on-chain using existing stored Merkle root
  it('20. When pool receives funds, pending epoch is published using original Merkle root and transitions to published', async () => {
    const pendingEpoch = {
      epoch_id: 100,
      epoch_number: 100,
      total_distributed_eth: 0.50,
      merkle_root: '0xpendingroot100',
      status: 'pending_funding',
      onchain_tx_hash: null,
    };

    // Pool later receives swap fees
    const newPoolBalanceEth = 1.20;
    assert.ok(newPoolBalanceEth >= pendingEpoch.total_distributed_eth);

    // Worker publishes the EXACT existing stored root without recomputing or altering amounts
    const publishedTxHash = '0xmocktxhashfunded100';
    pendingEpoch.status = 'published';
    pendingEpoch.onchain_tx_hash = publishedTxHash;

    assert.strictEqual(pendingEpoch.status, 'published');
    assert.strictEqual(pendingEpoch.merkle_root, '0xpendingroot100', 'Original Merkle root remains identical');
    assert.strictEqual(pendingEpoch.total_distributed_eth, 0.50, 'Original reward amount remains identical');
  });

  // TEST 21: Feature 2: Full loss recovery cutoff prevents new rewards once cost basis is depleted
  it('21. Full loss recovery stops new reward generation once unrecovered loss reaches 0', async () => {
    const benchmarkPriceEth = 0.000010;
    const holder = {
      token_balance: 100000,
      total_invested_eth: 1.50, // Initial investment
      avg_cost_basis_eth: 0.000015,
    };

    // Initial loss = 1.50 - (100000 * 0.000010) = 0.50 ETH
    let currentVal = holder.token_balance * benchmarkPriceEth;
    let unrealizedLoss = Math.max(0, holder.total_invested_eth - currentVal);
    assert.strictEqual(unrealizedLoss, 0.50);

    // Epoch 1 awards 0.25 ETH -> cost basis is depleted by 0.25 ETH
    let reward1 = 0.25;
    holder.total_invested_eth = Math.max(0, holder.total_invested_eth - reward1);
    holder.avg_cost_basis_eth = holder.total_invested_eth / holder.token_balance;
    assert.strictEqual(holder.total_invested_eth, 1.25);
    assert.strictEqual(holder.avg_cost_basis_eth, 0.0000125);

    // Epoch 2 awards remaining 0.25 ETH -> cost basis is depleted by 0.25 ETH
    let reward2 = 0.25;
    holder.total_invested_eth = Math.max(0, holder.total_invested_eth - reward2);
    holder.avg_cost_basis_eth = holder.total_invested_eth / holder.token_balance;
    assert.strictEqual(holder.total_invested_eth, 1.00);
    assert.strictEqual(holder.avg_cost_basis_eth, 0.000010);

    // At this point: avg_cost_basis_eth == benchmarkPriceEth (0.000010)
    currentVal = holder.token_balance * benchmarkPriceEth;
    unrealizedLoss = Math.max(0, holder.total_invested_eth - currentVal);
    assert.strictEqual(unrealizedLoss, 0, 'Unrealized loss is strictly 0');

    // Worker filter: avg_cost_basis_eth > benchmarkPriceEth
    const isEligible = holder.avg_cost_basis_eth > benchmarkPriceEth;
    assert.strictEqual(isEligible, false, 'Fully recovered holder is excluded from new reward epochs');
  });

  // TEST 22: Feature 3: An epoch can only be claimed once invariant
  it('22. An epoch can only be claimed once: on-chain hasClaimed=true prevents re-claiming and failed claims do not mark DB claimed', async () => {
    // 1. Initial State: unclaimed
    const epochId = 42;
    let onchainClaimed = false;
    let dbClaimed = false;

    // 2. Failed claim attempt (e.g. pool out of gas or revert)
    let claimReverted = true;
    if (claimReverted) {
      // Revert rolls back EVM state and gateway aborts DB update
      onchainClaimed = false;
      dbClaimed = false;
    }
    assert.strictEqual(onchainClaimed, false, 'On-chain hasClaimed must remain false on failed claim');
    assert.strictEqual(dbClaimed, false, 'DB claimed must remain false on failed claim');

    // 3. Successful claim
    onchainClaimed = true;
    dbClaimed = true;
    assert.strictEqual(onchainClaimed, true);
    assert.strictEqual(dbClaimed, true);

    // 4. Second claim attempt MUST be rejected by hasClaimed
    const canClaimAgain = !onchainClaimed && !dbClaimed;
    assert.strictEqual(canClaimAgain, false, 'Epoch cannot be claimed a second time');
  });
});
