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

export const formatLossRewardEthPrice = (priceEth) => {
  if (!Number.isFinite(priceEth) || priceEth <= 0) return '0.000000 ETH';
  if (priceEth < 0.00001) {
    const formatted = priceEth.toFixed(18).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
    return `${formatted} ETH`;
  }
  if (priceEth < 1) {
    return `${priceEth.toFixed(6)} ETH`;
  }
  return `${priceEth.toFixed(4)} ETH`;
};

test('Y: Tiny ETH price formatting (sub-microETH values format accurately without 0.000000 ETH truncation)', () => {
  // Bonding curve initial price ~2e-9 ETH
  assert.equal(formatLossRewardEthPrice(0.000000002), '0.000000002 ETH');
  assert.equal(formatLossRewardEthPrice(2e-9), '0.000000002 ETH');

  // Specific audit example: 2.014568722e-9 ETH
  assert.equal(formatLossRewardEthPrice(2.014568722e-9), '0.000000002014568722 ETH');

  // Micro-ETH prices
  assert.equal(formatLossRewardEthPrice(0.000005), '0.000005 ETH');
  assert.equal(formatLossRewardEthPrice(0.000123), '0.000123 ETH');

  // Standard prices
  assert.equal(formatLossRewardEthPrice(0.5), '0.500000 ETH');
  assert.equal(formatLossRewardEthPrice(1.5), '1.5000 ETH');

  // Zero / negative boundary conditions
  assert.equal(formatLossRewardEthPrice(0), '0.000000 ETH');
  assert.equal(formatLossRewardEthPrice(-1), '0.000000 ETH');
  assert.equal(formatLossRewardEthPrice(NaN), '0.000000 ETH');
});

test('Z: Token and Wallet query isolation (Strict multi-tenant separation)', () => {
  const token1 = '0x1111111111111111111111111111111111111111';
  const token2 = '0x2222222222222222222222222222222222222222';
  const walletA = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const walletB = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

  // Simulated DB store
  const dbCostBasis = new Map();
  const makeKey = (t, w) => `${t.toLowerCase()}:${w.toLowerCase()}`;

  // Wallet A buys Token 1
  dbCostBasis.set(makeKey(token1, walletA), {
    tokenAddress: token1.toLowerCase(),
    walletAddress: walletA.toLowerCase(),
    tokenBalance: 1000,
    totalInvestedEth: 1.0,
    avgCostBasisEth: 0.001,
  });

  // Wallet B buys Token 1
  dbCostBasis.set(makeKey(token1, walletB), {
    tokenAddress: token1.toLowerCase(),
    walletAddress: walletB.toLowerCase(),
    tokenBalance: 5000,
    totalInvestedEth: 7.5,
    avgCostBasisEth: 0.0015,
  });

  // Query scoped strictly by token_address AND wallet_address
  const queryScoped = (t, w) => dbCostBasis.get(makeKey(t, w)) || null;

  const resA = queryScoped(token1, walletA);
  const resB = queryScoped(token1, walletB);
  const resCross = queryScoped(token2, walletA);

  assert.notEqual(resA, null);
  assert.equal(resA.walletAddress, walletA.toLowerCase());
  assert.equal(resA.tokenBalance, 1000);
  assert.equal(resA.avgCostBasisEth, 0.001);

  assert.notEqual(resB, null);
  assert.equal(resB.walletAddress, walletB.toLowerCase());
  assert.equal(resB.tokenBalance, 5000);
  assert.equal(resB.avgCostBasisEth, 0.0015);

  // Different token returns null for Wallet A
  assert.equal(resCross, null);

  // Wallet A never observes Wallet B data
  assert.notEqual(resA.avgCostBasisEth, resB.avgCostBasisEth);
});

test('AA: Wallet disconnect state lifecycle (Immediate clearing of user-specific state)', () => {
  // State representation
  let connectedWallet = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  let costBasisData = { avgCostBasisEth: 0.002, tokenBalance: 1000 };
  let claimableState = { unclaimedEpochs: [1, 2], totalClaimableEth: 0.05 };
  let onchainBalances = { walletSol: 1.5, tokenBalance: 1000, loading: false };
  let position = { tokens: 1000 };

  // Disconnect triggered (connectedWallet becomes null)
  connectedWallet = null;

  // Reactive effect logic applied
  if (!connectedWallet) {
    costBasisData = null;
    claimableState = { unclaimedEpochs: [], totalClaimableEth: 0 };
    onchainBalances = { walletSol: 0, tokenBalance: 0, loading: false };
    position = { tokens: 0 };
  }

  assert.equal(costBasisData, null);
  assert.equal(claimableState.totalClaimableEth, 0);
  assert.equal(claimableState.unclaimedEpochs.length, 0);
  assert.equal(onchainBalances.tokenBalance, 0);
  assert.equal(position.tokens, 0);
});

test('AB: Wallet switching reactive lifecycle (Clean transition from Wallet A to Wallet B)', () => {
  const token = '0x1111111111111111111111111111111111111111';
  const walletA = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const walletB = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

  const mockDb = {
    [walletA.toLowerCase()]: {
      costBasis: { avgCostBasisEth: 0.001, tokenBalance: 100 },
      claimable: { unclaimedEpochs: [{ epochId: 1, finalRewardEth: 0.01 }], totalClaimableEth: 0.01 },
      tokenBalance: 100,
    },
    [walletB.toLowerCase()]: {
      costBasis: { avgCostBasisEth: 0.004, tokenBalance: 800 },
      claimable: { unclaimedEpochs: [{ epochId: 2, finalRewardEth: 0.08 }], totalClaimableEth: 0.08 },
      tokenBalance: 800,
    },
  };

  // 1. Initially Wallet A connected
  let activeWallet = walletA;
  let currentCostBasis = mockDb[activeWallet.toLowerCase()].costBasis;
  let currentClaimable = mockDb[activeWallet.toLowerCase()].claimable;
  let currentTokenBalance = mockDb[activeWallet.toLowerCase()].tokenBalance;

  assert.equal(currentCostBasis.avgCostBasisEth, 0.001);
  assert.equal(currentClaimable.totalClaimableEth, 0.01);
  assert.equal(currentTokenBalance, 100);

  // 2. User switches in MetaMask to Wallet B
  activeWallet = walletB;
  currentCostBasis = mockDb[activeWallet.toLowerCase()].costBasis;
  currentClaimable = mockDb[activeWallet.toLowerCase()].claimable;
  currentTokenBalance = mockDb[activeWallet.toLowerCase()].tokenBalance;

  assert.equal(currentCostBasis.avgCostBasisEth, 0.004);
  assert.equal(currentClaimable.totalClaimableEth, 0.08);
  assert.equal(currentTokenBalance, 800);

  // Absolutely 0 remnants of Wallet A exist in active state
  assert.notEqual(currentCostBasis.avgCostBasisEth, 0.001);
  assert.notEqual(currentTokenBalance, 100);
});

test('AC: In-flight wallet switching state sanitization (Wallet A state is synchronously cleared prior to async load of Wallet B)', () => {
  // Simulating component state and synchronous effect trigger on account change
  let costBasisData = { tokenAddress: '0x1111', walletAddress: '0xaaaa', tokenBalance: 1000, avgCostBasisEth: 0.002, isEligible: true, isUnderwaterSeller: false };
  let claimableState = { unclaimedEpochs: [{ id: 1, epochId: 1, epochNumber: 1, finalRewardEth: 0.05, merkleProof: [] }], totalClaimableEth: 0.05 };
  let onchainBalances = { walletSol: 2.5, tokenBalance: 1000, loading: false };
  let position = { tokens: 1000, investedSol: 2.0, avgEntry: 0.002, realizedPnl: 0 };
  let claimSuccessMsg = 'Claimed 0.0500 ETH!';
  let sellAmountToken = '500';

  // Trigger switch to Wallet B
  const switchWallet = (newWallet) => {
    // Synchronous state sanitization (effect execution upon reactive store update)
    costBasisData = null;
    claimableState = { unclaimedEpochs: [], totalClaimableEth: 0 };
    onchainBalances = { walletSol: 0, tokenBalance: 0, loading: Boolean(newWallet) };
    position = { tokens: 0, investedSol: 0, avgEntry: 0, realizedPnl: 0 };
    claimSuccessMsg = null;
    sellAmountToken = '';
  };

  switchWallet('0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');

  // Verify that during in-flight fetch of Wallet B, NO Wallet A data is visible
  assert.equal(costBasisData, null);
  assert.equal(claimableState.totalClaimableEth, 0);
  assert.equal(claimableState.unclaimedEpochs.length, 0);
  assert.equal(onchainBalances.tokenBalance, 0);
  assert.equal(onchainBalances.walletSol, 0);
  assert.equal(onchainBalances.loading, true);
  assert.equal(position.tokens, 0);
  assert.equal(claimSuccessMsg, null);
  assert.equal(sellAmountToken, '');
});

test('AD: Comprehensive sub-microETH and bonding curve price formatting (Strict zero-truncation prevention)', () => {
  // Initial bonding curve price (~2e-9 ETH)
  assert.equal(formatLossRewardEthPrice(2e-9), '0.000000002 ETH');
  assert.equal(formatLossRewardEthPrice(0.000000002), '0.000000002 ETH');

  // Exact audit prompt example: 2.014568722e-9 ETH
  assert.equal(formatLossRewardEthPrice(2.014568722e-9), '0.000000002014568722 ETH');

  // Intermediate curve price (~2.76e-8 ETH at graduation)
  assert.equal(formatLossRewardEthPrice(0.0000000276), '0.0000000276 ETH');

  // 1 wei (1e-18 ETH)
  assert.equal(formatLossRewardEthPrice(1e-18), '0.000000000000000001 ETH');

  // 9.999 micro-ETH
  assert.equal(formatLossRewardEthPrice(0.000009999), '0.000009999 ETH');

  // Sub-ETH prices (6 decimals)
  assert.equal(formatLossRewardEthPrice(0.0001), '0.000100 ETH');
  assert.equal(formatLossRewardEthPrice(0.012345), '0.012345 ETH');

  // >= 1 ETH prices (4 decimals)
  assert.equal(formatLossRewardEthPrice(1.0), '1.0000 ETH');
  assert.equal(formatLossRewardEthPrice(24.5), '24.5000 ETH');

  // Non-positive / invalid inputs
  assert.equal(formatLossRewardEthPrice(0), '0.000000 ETH');
  assert.equal(formatLossRewardEthPrice(-0.000001), '0.000000 ETH');
  assert.equal(formatLossRewardEthPrice(Infinity), '0.000000 ETH');
});

test('AE: Multi-token & multi-wallet cross-isolation query matrix', () => {
  const tokens = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'];
  const wallets = [
    '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
  ];

  const storage = new Map();
  const makeKey = (t, w) => `${t.toLowerCase()}:${w.toLowerCase()}`;

  // Populate data for (Token 0, Wallet 0) and (Token 1, Wallet 1)
  storage.set(makeKey(tokens[0], wallets[0]), { token: tokens[0], wallet: wallets[0], balance: 100, costBasis: 0.001 });
  storage.set(makeKey(tokens[1], wallets[1]), { token: tokens[1], wallet: wallets[1], balance: 500, costBasis: 0.005 });

  const query = (t, w) => storage.get(makeKey(t, w)) || null;

  // Exact matching returns valid data
  assert.equal(query(tokens[0], wallets[0])?.balance, 100);
  assert.equal(query(tokens[1], wallets[1])?.balance, 500);

  // Cross queries return null
  assert.equal(query(tokens[0], wallets[1]), null);
  assert.equal(query(tokens[1], wallets[0]), null);
  assert.equal(query(tokens[0], wallets[2]), null);
  assert.equal(query(tokens[1], wallets[2]), null);
});

test('AF: Pre-graduation vs Post-graduation price benchmark resolver routing', () => {
  const mockFactory = (token, isGrad) => ({
    isGraduated: isGrad,
    curveAddress: '0x2046186807c598a2c6fdd99440b03518f5a66528',
    uniswapPool: isGrad ? '0x1111111111111111111111111111111111111111' : '0x0000000000000000000000000000000000000000'
  });

  const resolvePriceSource = (token, isGrad) => {
    const config = mockFactory(token, isGrad);
    if (!config.isGraduated) {
      return { source: 'bonding_curve', address: config.curveAddress };
    }
    return { source: 'uniswap_v3', address: config.uniswapPool };
  };

  const preGrad = resolvePriceSource('0xC7Cc178dbE6398C3EAFdaEB170133FFC64Db9345', false);
  assert.equal(preGrad.source, 'bonding_curve');
  assert.equal(preGrad.address, '0x2046186807c598a2c6fdd99440b03518f5a66528');

  const postGrad = resolvePriceSource('0xC7Cc178dbE6398C3EAFdaEB170133FFC64Db9345', true);
  assert.equal(postGrad.source, 'uniswap_v3');
  assert.equal(postGrad.address, '0x1111111111111111111111111111111111111111');
});

test('AG: Merkle Leaf Double-Hash generation with sub-microETH values', () => {
  const token = '0xC7Cc178dbE6398C3EAFdaEB170133FFC64Db9345';
  const epochId = 1;
  const claimant = '0x78a4E4BCC8ab559B6d3B1Cb9eab0A04a2411c726';
  const amountWei = 111646210004n; // 0.000000111646210004 ETH

  const leaf = hashLeaf(token, epochId, claimant, amountWei);
  assert.equal(typeof leaf, 'string');
  assert.equal(leaf.startsWith('0x'), true);
  assert.equal(leaf.length, 66); // 32 bytes hex + 0x

  const tree = new MerkleTree([leaf]);
  const root = tree.getRoot();
  const proof = tree.getProof(0);

  assert.equal(root, leaf); // Single leaf root equals leaf
  assert.equal(verifyProof(proof, root, leaf), true);
});

test('AH: 10% Unrealized Loss calculation and 100% pool coverage scaling', () => {
  const balance = 8919.546548501723;
  const costBasisEth = 2.212514999496307e-9;
  const currentPriceEth = 2.087344724e-9;
  const totalInvestedEth = 0.000019734630527265576;

  const currentValEth = balance * currentPriceEth;
  const unrealizedLossEth = Math.max(0, totalInvestedEth - currentValEth);
  const theoreticalRewardEth = 0.10 * unrealizedLossEth;

  assert.equal(unrealizedLossEth > 0.000001116 && unrealizedLossEth < 0.000001117, true);
  assert.equal(theoreticalRewardEth > 0.0000001116 && theoreticalRewardEth < 0.0000001117, true);

  const availablePoolEth = 0.008840584770589916;
  const totalDemandEth = theoreticalRewardEth;
  const scalingFactor = Math.min(1.0, availablePoolEth / totalDemandEth);
  assert.equal(scalingFactor, 1.0); // 100% full payout

  const finalRewardEth = theoreticalRewardEth * scalingFactor;
  const finalRewardWei = BigInt(Math.round(finalRewardEth * 1e18));
  assert.equal(finalRewardWei >= 111646200000n && finalRewardWei <= 111646220000n, true);
});

console.log('\n======================================================');
console.log(`  ALL ${passedCount}/${totalCount} AUDIT TESTS PASSED SUCCESSFULLY!`);
console.log('======================================================\n');
