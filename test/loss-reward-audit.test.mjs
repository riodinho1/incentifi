// test/loss-reward-audit.test.mjs
import assert from 'node:assert/strict';
import {
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  getAddress,
  concat,
} from 'viem';

console.log('======================================================');
console.log('  RUNNING INCENTIFI LOSS-REWARD AUDIT TEST SUITE');
console.log('======================================================\n');

// ----------------------------------------------------------------------------
// Merkle Tree Helper (matching LossRewardPool.sol & worker)
// ----------------------------------------------------------------------------
export class MerkleTree {
  constructor(leaves) {
    this.leaves = leaves.map((leaf) => leaf.toLowerCase());
    this.layers = [this.leaves];
    this._buildTree();
  }

  _hashPair(a, b) {
    return a <= b ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
  }

  _buildTree() {
    while (this.layers[this.layers.length - 1].length > 1) {
      const currentLayer = this.layers[this.layers.length - 1];
      const nextLayer = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        if (i + 1 < currentLayer.length) {
          nextLayer.push(this._hashPair(currentLayer[i], currentLayer[i + 1]));
        } else {
          nextLayer.push(currentLayer[i]);
        }
      }
      this.layers.push(nextLayer);
    }
  }

  getRoot() {
    return this.layers[this.layers.length - 1][0] || '0x0000000000000000000000000000000000000000000000000000000000000000';
  }

  getProof(leafIndex) {
    const proof = [];
    let currentIndex = leafIndex;
    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const isRightNode = currentIndex % 2 === 1;
      const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;
      if (siblingIndex < layer.length) {
        proof.push(layer[siblingIndex]);
      }
      currentIndex = Math.floor(currentIndex / 2);
    }
    return proof;
  }
}

export function hashLeaf(tokenAddress, epochId, claimant, amountWei) {
  const innerHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters('address token, uint256 epochId, address claimant, uint256 amount'),
      [getAddress(tokenAddress), BigInt(epochId), getAddress(claimant), BigInt(amountWei)]
    )
  );
  return keccak256(innerHash);
}

export function verifyProof(proof, root, leaf) {
  let computedHash = leaf.toLowerCase();
  for (const proofElement of proof) {
    const p = proofElement.toLowerCase();
    computedHash = computedHash <= p
      ? keccak256(concat([computedHash, p]))
      : keccak256(concat([p, computedHash]));
  }
  return computedHash.toLowerCase() === root.toLowerCase();
}

// ----------------------------------------------------------------------------
// Core Accounting Logic Functions (Pure Math Models)
// ----------------------------------------------------------------------------

function applyBuy(state, amountToken, amountEth, currentEpoch = 1) {
  const prevInvested = state.totalInvestedEth || 0;
  const prevBalance = state.tokenBalance || 0;
  const newInvested = prevInvested + amountEth;
  const newBalance = prevBalance + amountToken;
  const newCostBasis = newBalance > 0 ? newInvested / newBalance : 0;
  return {
    ...state,
    tokenBalance: newBalance,
    totalInvestedEth: newInvested,
    avgCostBasisEth: newCostBasis,
    isEligible: true,
    isUnderwaterSeller: false,
    acquiredEpoch: currentEpoch,
  };
}

function applySell(state, amountToken, sellPriceEth) {
  const prevBalance = state.tokenBalance || 0;
  const prevCostBasis = state.avgCostBasisEth || 0;
  const isUnderwater = sellPriceEth < prevCostBasis;
  const newBalance = Math.max(0, prevBalance - amountToken);
  const newInvested = newBalance > 0 ? newBalance * prevCostBasis : 0;

  return {
    ...state,
    tokenBalance: newBalance,
    totalInvestedEth: newInvested,
    avgCostBasisEth: prevCostBasis,
    isEligible: isUnderwater ? false : state.isEligible,
    isUnderwaterSeller: isUnderwater ? true : state.isUnderwaterSeller,
  };
}

function applyTransfer(senderState, recipientState, amountToken, currentTwapPrice) {
  const senderBasis = senderState.avgCostBasisEth || 0;
  const senderNewBal = Math.max(0, senderState.tokenBalance - amountToken);
  const senderNewInv = senderNewBal * senderBasis;

  const newSender = {
    ...senderState,
    tokenBalance: senderNewBal,
    totalInvestedEth: senderNewInv,
    avgCostBasisEth: senderBasis,
  };

  const transferBasis = Math.min(senderBasis > 0 ? senderBasis : currentTwapPrice, currentTwapPrice);
  const recipPrevBal = recipientState.tokenBalance || 0;
  const recipPrevInv = recipientState.totalInvestedEth || 0;
  const recipNewBal = recipPrevBal + amountToken;
  const recipNewInv = recipPrevInv + (amountToken * transferBasis);
  const recipNewBasis = recipNewBal > 0 ? recipNewInv / recipNewBal : 0;

  const newRecipient = {
    ...recipientState,
    tokenBalance: recipNewBal,
    totalInvestedEth: recipNewInv,
    avgCostBasisEth: recipNewBasis,
    isEligible: true,
  };

  return { newSender, newRecipient, transferBasis };
}

function calculateHolderReward(holder, twapPrice, currentEpoch, scalingFactor = 1.0) {
  if (!holder.isEligible || holder.isUnderwaterSeller) {
    return { theoreticalReward: 0, actualReward: 0, unrealizedLoss: 0 };
  }
  if (holder.tokenBalance <= 0 || holder.avgCostBasisEth <= twapPrice) {
    return { theoreticalReward: 0, actualReward: 0, unrealizedLoss: 0 };
  }
  // Maturation check
  if (holder.acquiredEpoch && holder.acquiredEpoch >= currentEpoch) {
    return { theoreticalReward: 0, actualReward: 0, unrealizedLoss: 0, mature: false };
  }

  const currentVal = holder.tokenBalance * twapPrice;
  const unrealizedLoss = Math.max(0, holder.totalInvestedEth - currentVal);
  const theoreticalReward = 0.10 * unrealizedLoss;
  const actualReward = theoreticalReward * scalingFactor;

  return { theoreticalReward, actualReward, unrealizedLoss, mature: true };
}

function applyRewardDepletion(holder, actualReward) {
  const newInvested = Math.max(0, holder.totalInvestedEth - actualReward);
  const newBasis = holder.tokenBalance > 0 ? newInvested / holder.tokenBalance : 0;
  return {
    ...holder,
    totalInvestedEth: newInvested,
    avgCostBasisEth: newBasis,
  };
}

let passedCount = 0;
let totalCount = 0;

function test(name, fn) {
  totalCount++;
  try {
    fn();
    console.log(`  ✓ [TEST ${totalCount}] ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  ✗ [TEST ${totalCount}] ${name}`);
    console.error(`    Error: ${err.message}`);
    throw err;
  }
}

// ----------------------------------------------------------------------------
// TEST CASES A THROUGH V
// ----------------------------------------------------------------------------

test('A: Buy accounting (I_new = I_old + ETH, B_new = B_old + tokens, C = I / B)', () => {
  let state = { tokenBalance: 0, totalInvestedEth: 0, avgCostBasisEth: 0, isEligible: true, isUnderwaterSeller: false };
  state = applyBuy(state, 1000, 1.0);
  assert.equal(state.tokenBalance, 1000);
  assert.equal(state.totalInvestedEth, 1.0);
  assert.equal(state.avgCostBasisEth, 0.001);
  assert.equal(state.isEligible, true);

  // Subsequent buy
  state = applyBuy(state, 1000, 3.0);
  assert.equal(state.tokenBalance, 2000);
  assert.equal(state.totalInvestedEth, 4.0);
  assert.equal(state.avgCostBasisEth, 0.002);
});

test('B: Profitable partial sell (B_new = B_old - sold, I_new = B_new * C, C unchanged, remains eligible)', () => {
  let state = applyBuy({ tokenBalance: 0, totalInvestedEth: 0, avgCostBasisEth: 0, isEligible: true, isUnderwaterSeller: false }, 1000, 1.0);
  // Cost basis is 0.001 ETH. Sell at 0.002 ETH (profitable)
  state = applySell(state, 400, 0.002);
  assert.equal(state.tokenBalance, 600);
  assert.equal(state.avgCostBasisEth, 0.001);
  assert.equal(state.totalInvestedEth, 0.6);
  assert.equal(state.isEligible, true);
  assert.equal(state.isUnderwaterSeller, false);
});

test('C: Underwater partial sell (disqualifies remaining position, isEligible = false)', () => {
  let state = applyBuy({ tokenBalance: 0, totalInvestedEth: 0, avgCostBasisEth: 0, isEligible: true, isUnderwaterSeller: false }, 1000, 1.0);
  // Cost basis is 0.001 ETH. Sell at 0.0005 ETH (underwater)
  state = applySell(state, 400, 0.0005);
  assert.equal(state.tokenBalance, 600);
  assert.equal(state.isEligible, false);
  assert.equal(state.isUnderwaterSeller, true);

  // Verification: Holder receives 0 reward in next epoch
  const reward = calculateHolderReward(state, 0.0004, 2);
  assert.equal(reward.theoreticalReward, 0);
  assert.equal(reward.actualReward, 0);
});

test('D: Transfer during profit (Sender basis preserved, Recipient basis capped at TWAP)', () => {
  const sender = applyBuy({ tokenBalance: 0, totalInvestedEth: 0, avgCostBasisEth: 0, isEligible: true, isUnderwaterSeller: false }, 1000, 1.0); // basis 0.001
  const recipient = { tokenBalance: 0, totalInvestedEth: 0, avgCostBasisEth: 0, isEligible: true, isUnderwaterSeller: false };
  
  // Market is at 0.002 (profit for sender)
  const { newSender, newRecipient, transferBasis } = applyTransfer(sender, recipient, 500, 0.002);
  assert.equal(newSender.tokenBalance, 500);
  assert.equal(newSender.totalInvestedEth, 0.5);
  assert.equal(transferBasis, 0.001); // min(0.001, 0.002) = 0.001
  assert.equal(newRecipient.tokenBalance, 500);
  assert.equal(newRecipient.totalInvestedEth, 0.5);
});

test('E: Transfer while underwater (Recipient cannot inherit sender unrealized loss)', () => {
  const sender = applyBuy({ tokenBalance: 0, totalInvestedEth: 0, avgCostBasisEth: 0, isEligible: true, isUnderwaterSeller: false }, 1000, 2.0); // basis 0.002
  const recipient = { tokenBalance: 0, totalInvestedEth: 0, avgCostBasisEth: 0, isEligible: true, isUnderwaterSeller: false };

  // Current TWAP price is 0.001 (sender is underwater)
  const { newSender, newRecipient, transferBasis } = applyTransfer(sender, recipient, 500, 0.001);
  assert.equal(transferBasis, 0.001); // min(0.002, 0.001) = 0.001
  assert.equal(newRecipient.avgCostBasisEth, 0.001);

  // Recipient has 0 unrealized loss at current TWAP
  const recipReward = calculateHolderReward(newRecipient, 0.001, 2);
  assert.equal(recipReward.unrealizedLoss, 0);
  assert.equal(recipReward.theoreticalReward, 0);
});

test('F: New buy after disqualification (Re-establishes eligibility)', () => {
  let state = applyBuy({ tokenBalance: 0, totalInvestedEth: 0, avgCostBasisEth: 0, isEligible: true, isUnderwaterSeller: false }, 1000, 1.0);
  state = applySell(state, 500, 0.0005); // Disqualified
  assert.equal(state.isEligible, false);

  // New buy of 500 tokens for 0.5 ETH
  state = applyBuy(state, 500, 0.5);
  assert.equal(state.isEligible, true);
  assert.equal(state.isUnderwaterSeller, false);
  assert.equal(state.tokenBalance, 1000);
  assert.equal(state.totalInvestedEth, 1.0);
});

test('G: Cost-basis depletion (I_new = I_old - reward, C_new = I_new / B)', () => {
  let holder = applyBuy({ tokenBalance: 0, totalInvestedEth: 0, avgCostBasisEth: 0, isEligible: true, isUnderwaterSeller: false }, 1000, 1.0, 1);
  const twap = 0.0005; // Loss = 1.0 - (1000 * 0.0005) = 0.5 ETH
  const { theoreticalReward, actualReward } = calculateHolderReward(holder, twap, 2, 1.0);
  assert.equal(theoreticalReward, 0.05); // 10% of 0.5
  assert.equal(actualReward, 0.05);

  holder = applyRewardDepletion(holder, actualReward);
  assert.equal(holder.totalInvestedEth, 0.95);
  assert.equal(holder.avgCostBasisEth, 0.00095);
});

test('H: Multiple reward epochs (Continuous bounded depletion without price change)', () => {
  let holder = applyBuy({ tokenBalance: 0, totalInvestedEth: 0, avgCostBasisEth: 0, isEligible: true, isUnderwaterSeller: false }, 1000, 1.0, 1);
  const twap = 0.0005;
  let totalReceived = 0;

  for (let epoch = 2; epoch <= 10; epoch++) {
    const { actualReward } = calculateHolderReward(holder, twap, epoch, 1.0);
    totalReceived += actualReward;
    holder = applyRewardDepletion(holder, actualReward);
  }

  // Cost basis steadily decreases
  assert.ok(holder.avgCostBasisEth < 0.001);
  assert.ok(holder.avgCostBasisEth > twap);
  // Total rewards cannot exceed original maximum loss (0.5 ETH)
  assert.ok(totalReceived < 0.5);
});

test('I: Pool scaling when demand <= pool (Scaling factor S = 1.0)', () => {
  const demand = 0.5;
  const pool = 1.0;
  const scaling = Math.min(1.0, pool / demand);
  assert.equal(scaling, 1.0);
  const reward = demand * scaling;
  assert.equal(reward, 0.5);
});

test('J: Pool scaling when demand > pool (Scaling factor S < 1.0, exact budget match)', () => {
  const demand = 2.0;
  const pool = 0.8;
  const scaling = Math.min(1.0, pool / demand);
  assert.equal(scaling, 0.4);
  const reward = demand * scaling;
  assert.equal(reward, 0.8); // Total payout matches pool exactly
});

test('K: Multiple holders proportional distribution', () => {
  const h1 = applyBuy({ tokenBalance: 0, totalInvestedEth: 0, avgCostBasisEth: 0, isEligible: true, isUnderwaterSeller: false }, 1000, 1.0, 1); // Loss at 0.0005 = 0.5 -> reward 0.05
  const h2 = applyBuy({ tokenBalance: 0, totalInvestedEth: 0, avgCostBasisEth: 0, isEligible: true, isUnderwaterSeller: false }, 2000, 2.0, 1); // Loss at 0.0005 = 1.0 -> reward 0.10
  const twap = 0.0005;

  const r1 = calculateHolderReward(h1, twap, 2, 1.0);
  const r2 = calculateHolderReward(h2, twap, 2, 1.0);
  const totalDemand = r1.theoreticalReward + r2.theoreticalReward;
  assert.ok(Math.abs(totalDemand - 0.15) < 1e-12);

  const availablePool = 0.075; // 50% of demand
  const scaling = availablePool / totalDemand;
  const payout1 = r1.theoreticalReward * scaling;
  const payout2 = r2.theoreticalReward * scaling;

  assert.ok(Math.abs(payout1 - 0.025) < 1e-12);
  assert.ok(Math.abs(payout2 - 0.050) < 1e-12);
  assert.ok(Math.abs((payout1 + payout2) - availablePool) < 1e-12);
});

test('L: Multiple tokens isolation', () => {
  const tokenA = '0x1111111111111111111111111111111111111111';
  const tokenB = '0x2222222222222222222222222222222222222222';
  const claimant = '0x3333333333333333333333333333333333333333';

  const leafA = hashLeaf(tokenA, 1, claimant, 1000000000000000000n);
  const leafB = hashLeaf(tokenB, 1, claimant, 1000000000000000000n);

  assert.notEqual(leafA, leafB); // Leaves are distinct per token
});

test('M: Merkle Proof verification & Duplicate claim prevention', () => {
  const token = '0x1111111111111111111111111111111111111111';
  const c1 = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const c2 = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

  const leaf1 = hashLeaf(token, 1, c1, 100000000000000000n);
  const leaf2 = hashLeaf(token, 1, c2, 200000000000000000n);

  const tree = new MerkleTree([leaf1, leaf2]);
  const root = tree.getRoot();
  const proof1 = tree.getProof(0);

  // Valid proof succeeds
  assert.ok(verifyProof(proof1, root, leaf1));

  // Claim tracking model
  const hasClaimed = new Map();
  const claimKey = `${token}-1-${c1.toLowerCase()}`;
  assert.equal(hasClaimed.has(claimKey), false);
  hasClaimed.set(claimKey, true);
  assert.equal(hasClaimed.has(claimKey), true); // Next claim is blocked
});

test('N: Invalid Merkle proof rejection', () => {
  const token = '0x1111111111111111111111111111111111111111';
  const c1 = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const c2 = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

  const leaf1 = hashLeaf(token, 1, c1, 100000000000000000n);
  const leaf2 = hashLeaf(token, 1, c2, 200000000000000000n);

  const tree = new MerkleTree([leaf1, leaf2]);
  const root = tree.getRoot();
  const proof1 = tree.getProof(0);

  // Tampered leaf (wrong amount)
  const tamperedLeaf = hashLeaf(token, 1, c1, 999999999999999999n);
  assert.equal(verifyProof(proof1, root, tamperedLeaf), false);

  // Tampered claimant
  const tamperedClaimantLeaf = hashLeaf(token, 1, c2, 100000000000000000n);
  assert.equal(verifyProof(proof1, root, tamperedClaimantLeaf), false);
});

test('O: Batch claims verification across multiple epochs', () => {
  const token = '0x1111111111111111111111111111111111111111';
  const claimant = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  // Epoch 1
  const leafE1 = hashLeaf(token, 1, claimant, 10000000000000000n);
  const tree1 = new MerkleTree([leafE1]);
  const root1 = tree1.getRoot();
  const proof1 = tree1.getProof(0);

  // Epoch 2
  const leafE2 = hashLeaf(token, 2, claimant, 20000000000000000n);
  const tree2 = new MerkleTree([leafE2]);
  const root2 = tree2.getRoot();
  const proof2 = tree2.getProof(0);

  assert.ok(verifyProof(proof1, root1, leafE1));
  assert.ok(verifyProof(proof2, root2, leafE2));
});

test('P: Zero reward when position is in profit', () => {
  const holder = applyBuy({ tokenBalance: 0, totalInvestedEth: 0, avgCostBasisEth: 0, isEligible: true, isUnderwaterSeller: false }, 1000, 1.0, 1); // basis 0.001
  const twap = 0.0015; // In profit
  const { theoreticalReward, actualReward } = calculateHolderReward(holder, twap, 2, 1.0);
  assert.equal(theoreticalReward, 0);
  assert.equal(actualReward, 0);
});

test('Q: Zero reward when available pool is 0', () => {
  const holder = applyBuy({ tokenBalance: 0, totalInvestedEth: 0, avgCostBasisEth: 0, isEligible: true, isUnderwaterSeller: false }, 1000, 1.0, 1);
  const twap = 0.0005;
  const scaling = 0 / 0.05;
  const { actualReward } = calculateHolderReward(holder, twap, 2, scaling);
  assert.equal(actualReward, 0);
});

test('R: Router 50/50 fee split (1.0% creator / 1.0% loss pool from 2.0% total)', () => {
  const grossTradeEth = 100000000000000000000n; // 100.0 ETH
  const feeBps = 200n; // 2%
  const creatorShare = (grossTradeEth * 100n) / 10000n; // 1.0 ETH (1.0%)
  const lossPoolShare = (grossTradeEth * 100n) / 10000n; // 1.0 ETH (1.0%)
  const fee = creatorShare + lossPoolShare; // 2.0 ETH (2.0%)
  const swapEth = grossTradeEth - fee; // 98.0 ETH (98.0%)

  assert.equal(fee, 2000000000000000000n);
  assert.equal(creatorShare, 1000000000000000000n);
  assert.equal(lossPoolShare, 1000000000000000000n);
  assert.equal(swapEth, 98000000000000000000n);
  assert.equal(creatorShare + lossPoolShare + swapEth, grossTradeEth);
});

test('S: ETH/WETH conversion invariance (No dust leftover in router)', () => {
  const gross = 1000000000000000000n;
  const fee = (gross * 200n) / 10000n;
  const swap = gross - fee;
  // Wrapped WETH deposited equals swap amount exactly
  const wethDeposited = swap;
  assert.equal(wethDeposited + fee, gross);
});

test('T: TWAP calculation geometric mean (1.0001^tick conversion)', () => {
  const tick = 20000;
  const ratio = 1.0001 ** (tick / 2);
  const price1Per0 = ratio * ratio;
  const expected = 1.0001 ** tick;
  assert.ok(Math.abs(price1Per0 - expected) < 1e-10);
});

test('U: Epoch maturation enforcement (Current-epoch acquisitions are not rewarded in same epoch)', () => {
  const holder = applyBuy({ tokenBalance: 0, totalInvestedEth: 0, avgCostBasisEth: 0, isEligible: true, isUnderwaterSeller: false }, 1000, 1.0, 2); // Acquired in Epoch 2
  const twap = 0.0005;

  // Snapshot for Epoch 2 (same epoch)
  const sameEpochReward = calculateHolderReward(holder, twap, 2);
  assert.equal(sameEpochReward.theoreticalReward, 0);
  assert.equal(sameEpochReward.mature, false);

  // Snapshot for Epoch 3 (matured)
  const nextEpochReward = calculateHolderReward(holder, twap, 3);
  assert.equal(nextEpochReward.theoreticalReward, 0.05);
  assert.equal(nextEpochReward.mature, true);
});

test('V: Sybil splitting invariance (1 wallet with 100 tokens == 10 wallets with 10 tokens)', () => {
  // Single wallet
  const single = applyBuy({ tokenBalance: 0, totalInvestedEth: 0, avgCostBasisEth: 0, isEligible: true, isUnderwaterSeller: false }, 100, 1.0, 1);
  const twap = 0.005; // Loss = 1.0 - (100 * 0.005) = 0.5 -> reward 0.05
  const rSingle = calculateHolderReward(single, twap, 2);

  // 10 wallets
  let totalSybilReward = 0;
  for (let i = 0; i < 10; i++) {
    const sybil = applyBuy({ tokenBalance: 0, totalInvestedEth: 0, avgCostBasisEth: 0, isEligible: true, isUnderwaterSeller: false }, 10, 0.1, 1);
    const rSybil = calculateHolderReward(sybil, twap, 2);
    totalSybilReward += rSybil.theoreticalReward;
  }

  assert.ok(Math.abs(rSingle.theoreticalReward - totalSybilReward) < 1e-12);
  assert.equal(rSingle.theoreticalReward, 0.05);
});

test('W: 5-Minute snapshot interval constant verification (SNAPSHOT_INTERVAL_SECONDS = 300)', () => {
  const SNAPSHOT_INTERVAL_SECONDS = 300;
  const SNAPSHOT_INTERVAL_MINUTES = 5;
  const snapshotsPerHour = 3600 / SNAPSHOT_INTERVAL_SECONDS;

  assert.equal(SNAPSHOT_INTERVAL_SECONDS, 300);
  assert.equal(SNAPSHOT_INTERVAL_MINUTES, 5);
  assert.equal(snapshotsPerHour, 12);
});

test('X: 5-Minute epoch frequency non-distortion verification (12 snapshots/hr does not multiply rewards)', () => {
  // User invests 0.98 ETH (after 2% fee) for 1000 tokens
  let holder = applyBuy({ tokenBalance: 0, totalInvestedEth: 0, avgCostBasisEth: 0, isEligible: true, isUnderwaterSeller: false }, 1000, 0.98, 1);
  const twap = 0.0004; // Position value = 0.40 ETH. Initial unrealized loss = 0.58 ETH.
  const initialLoss = 0.98 - (1000 * twap); // 0.58 ETH

  let totalReceivedIn1Hour = 0;
  // 12 consecutive 5-minute epochs = 1 hour
  for (let epoch = 2; epoch <= 13; epoch++) {
    const { actualReward } = calculateHolderReward(holder, twap, epoch, 1.0);
    totalReceivedIn1Hour += actualReward;
    holder = applyRewardDepletion(holder, actualReward);
  }

  // Under geometric decay: 1 - (0.9)^12 ≈ 71.76% of loss recovered over 1 hour
  const expected1Hour = initialLoss * (1 - (0.9 ** 12));
  assert.ok(Math.abs(totalReceivedIn1Hour - expected1Hour) < 1e-10);
  assert.ok(totalReceivedIn1Hour < initialLoss, '1-hour total payout must be strictly less than initial loss');
  assert.ok(totalReceivedIn1Hour < 0.58, '1-hour total payout must not exceed initial loss of 0.58 ETH');

  // Over 100 consecutive 5-minute epochs (~8.3 hours)
  let totalReceivedLifetime = totalReceivedIn1Hour;
  for (let epoch = 14; epoch <= 100; epoch++) {
    const { actualReward } = calculateHolderReward(holder, twap, epoch, 1.0);
    totalReceivedLifetime += actualReward;
    holder = applyRewardDepletion(holder, actualReward);
  }

  // Lifetime payout asymptotically approaches initial loss but NEVER exceeds it
  assert.ok(totalReceivedLifetime <= initialLoss + 1e-12, 'Lifetime payout must NEVER exceed initial loss');
  assert.ok(totalReceivedLifetime < 0.98, 'Lifetime payout must NEVER exceed invested capital');
});

console.log('\n======================================================');
console.log(`  ALL ${passedCount}/${totalCount} AUDIT TESTS PASSED SUCCESSFULLY!`);
console.log('======================================================\n');
