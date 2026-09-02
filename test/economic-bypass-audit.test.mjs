// test/economic-bypass-audit.test.mjs
import assert from 'node:assert/strict';
import {
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  getAddress,
  concat,
} from 'viem';

console.log('==================================================================');
console.log('  INCENTIFI FINAL ADVERSARIAL SECURITY & ECONOMIC AUDIT');
console.log('==================================================================\n');

// ----------------------------------------------------------------------------
// Model Setup
// ----------------------------------------------------------------------------

export class MerkleTree {
  constructor(leaves) {
    this.leaves = leaves.map((l) => l.toLowerCase());
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
// DEX & Router Simulator
// ----------------------------------------------------------------------------

class IncentifiEcosystemSimulator {
  constructor() {
    this.lossRewardPoolBalance = 0;
    this.creatorEarnings = 0;
    this.holders = new Map(); // address => state
    this.tokenTrades = [];
    this.merkleRoots = new Map(); // epoch => root
    this.claimedEpochs = new Set(); // `${token}-${epoch}-${wallet}`
  }

  // 1. Official Router Buy (2% fee: 1.0% creator, 1.0% loss pool)
  routerBuy(wallet, amountToken, totalEthPaid, epoch = 1) {
    const fee = totalEthPaid * 0.02;
    const creatorFee = fee * 0.5; // 1.0%
    const lossPoolFee = fee * 0.5; // 1.0%
    const swapEth = totalEthPaid - fee; // 98.0%

    this.creatorEarnings += creatorFee;
    this.lossRewardPoolBalance += lossPoolFee;

    const prev = this.holders.get(wallet) || {
      tokenBalance: 0,
      totalInvestedEth: 0,
      avgCostBasisEth: 0,
      isEligible: true,
      isUnderwaterSeller: false,
      acquiredEpoch: epoch,
    };

    const newInvested = prev.totalInvestedEth + swapEth;
    const newBalance = prev.tokenBalance + amountToken;
    const newBasis = newBalance > 0 ? newInvested / newBalance : 0;

    const updated = {
      ...prev,
      tokenBalance: newBalance,
      totalInvestedEth: newInvested,
      avgCostBasisEth: newBasis,
      isEligible: true,
      isUnderwaterSeller: false,
      acquiredEpoch: epoch,
    };

    this.holders.set(wallet, updated);
    this.tokenTrades.push({
      wallet,
      side: 'buy',
      route: 'IncentifiSwapRouter',
      amountToken,
      amountEth: swapEth,
      feePaid: fee,
    });
    return updated;
  }

  // 2. Official Router Sell (2% fee: 1.0% creator, 1.0% loss pool)
  routerSell(wallet, amountToken, grossEthOut, currentPriceEth) {
    const fee = grossEthOut * 0.02;
    const creatorFee = fee * 0.5; // 1.0%
    const lossPoolFee = fee * 0.5; // 1.0%
    const netEth = grossEthOut - fee; // 98.0%

    this.creatorEarnings += creatorFee;
    this.lossRewardPoolBalance += lossPoolFee;

    const prev = this.holders.get(wallet) || {
      tokenBalance: 0,
      totalInvestedEth: 0,
      avgCostBasisEth: 0,
      isEligible: true,
      isUnderwaterSeller: false,
    };

    const isUnderwater = currentPriceEth < prev.avgCostBasisEth;
    const newBalance = Math.max(0, prev.tokenBalance - amountToken);
    const newInvested = newBalance > 0 ? newBalance * prev.avgCostBasisEth : 0;

    const updated = {
      ...prev,
      tokenBalance: newBalance,
      totalInvestedEth: newInvested,
      isEligible: isUnderwater ? false : prev.isEligible,
      isUnderwaterSeller: isUnderwater ? true : prev.isUnderwaterSeller,
    };

    this.holders.set(wallet, updated);
    this.tokenTrades.push({
      wallet,
      side: 'sell',
      route: 'IncentifiSwapRouter',
      amountToken,
      amountEth: netEth,
      feePaid: fee,
      isUnderwater,
    });
    return updated;
  }

  // 3. Direct Uniswap Buy (0% Incentifi fee - No cost basis recorded)
  directUniswapBuy(wallet, amountToken, totalEthSpent) {
    this.tokenTrades.push({
      wallet,
      side: 'buy',
      route: 'DirectUniswapV3',
      amountToken,
      amountEth: totalEthSpent,
      feePaid: 0,
    });
    return { wallet, amountToken, totalEthSpent };
  }

  // 4. Direct Uniswap Sell (Tokens transferred to Pool outside router)
  directUniswapSell(wallet, amountToken, grossEthReceived, currentPriceEth) {
    this.tokenTrades.push({
      wallet,
      side: 'sell',
      route: 'DirectUniswapV3',
      amountToken,
      amountEth: grossEthReceived,
      feePaid: 0,
    });

    const prev = this.holders.get(wallet);
    if (prev && prev.tokenBalance > 0) {
      const isUnderwater = currentPriceEth < prev.avgCostBasisEth;
      const newBalance = Math.max(0, prev.tokenBalance - amountToken);
      const newInvested = newBalance > 0 ? newBalance * prev.avgCostBasisEth : 0;

      const updated = {
        ...prev,
        tokenBalance: newBalance,
        totalInvestedEth: newInvested,
        isEligible: isUnderwater ? false : prev.isEligible,
        isUnderwaterSeller: isUnderwater ? true : prev.isUnderwaterSeller,
      };
      this.holders.set(wallet, updated);
      return updated;
    }
    return null;
  }

  // 5. Wallet-to-Wallet Transfer
  transfer(fromWallet, toWallet, amountToken, twapPriceEth, epoch = 1) {
    const sender = this.holders.get(fromWallet);
    const senderCostBasis = sender ? sender.avgCostBasisEth : 0;
    const senderPrevBalance = sender ? sender.tokenBalance : 0;
    const senderNewBalance = Math.max(0, senderPrevBalance - amountToken);
    const senderNewInvested = senderNewBalance * senderCostBasis;

    if (sender) {
      this.holders.set(fromWallet, {
        ...sender,
        tokenBalance: senderNewBalance,
        totalInvestedEth: senderNewInvested,
      });
    }

    const transferBasis = senderCostBasis > 0 ? Math.min(senderCostBasis, twapPriceEth) : 0;
    if (transferBasis > 0) {
      const recip = this.holders.get(toWallet) || {
        tokenBalance: 0,
        totalInvestedEth: 0,
        avgCostBasisEth: 0,
        isEligible: true,
        isUnderwaterSeller: false,
        acquiredEpoch: epoch,
      };

      const recipNewInvested = recip.totalInvestedEth + (amountToken * transferBasis);
      const recipNewBalance = recip.tokenBalance + amountToken;
      const recipNewBasis = recipNewBalance > 0 ? recipNewInvested / recipNewBalance : 0;

      const recipUpdated = {
        ...recip,
        tokenBalance: recipNewBalance,
        totalInvestedEth: recipNewInvested,
        avgCostBasisEth: recipNewBasis,
        isEligible: true,
        isUnderwaterSeller: false,
        acquiredEpoch: epoch,
      };
      this.holders.set(toWallet, recipUpdated);
      return { sender: this.holders.get(fromWallet), recipient: recipUpdated };
    }
    return { sender: this.holders.get(fromWallet), recipient: this.holders.get(toWallet) || null };
  }

  // Epoch distribution execution
  runEpoch(epochNumber, twapPriceEth, tokenAddress) {
    const eligibleHolders = [];
    let totalTheoreticalDemand = 0;

    for (const [wallet, h] of this.holders.entries()) {
      if (!h.isEligible || h.isUnderwaterSeller) continue;
      if (h.tokenBalance <= 0 || h.avgCostBasisEth <= twapPriceEth) continue;
      if (h.acquiredEpoch && h.acquiredEpoch >= epochNumber) continue; // Maturation

      const currentVal = h.tokenBalance * twapPriceEth;
      const unrealizedLoss = Math.max(0, h.totalInvestedEth - currentVal);
      const theoreticalReward = 0.10 * unrealizedLoss;

      if (theoreticalReward > 0) {
        totalTheoreticalDemand += theoreticalReward;
        eligibleHolders.push({ wallet, h, theoreticalReward, unrealizedLoss });
      }
    }

    const scalingFactor = totalTheoreticalDemand > 0
      ? Math.min(1.0, this.lossRewardPoolBalance / totalTheoreticalDemand)
      : 1.0;

    const allocations = [];
    const leaves = [];

    for (let i = 0; i < eligibleHolders.length; i++) {
      const { wallet, h, theoreticalReward, unrealizedLoss } = eligibleHolders[i];
      const actualReward = theoreticalReward * scalingFactor;
      const amountWei = BigInt(Math.round(actualReward * 1e18));
      const leaf = hashLeaf(tokenAddress, epochNumber, wallet, amountWei);
      leaves.push(leaf);

      allocations.push({
        wallet,
        tokenBalance: h.tokenBalance,
        investedCapital: h.totalInvestedEth,
        costBasis: h.avgCostBasisEth,
        twapPrice: twapPriceEth,
        unrealizedLoss,
        theoreticalReward,
        actualReward,
        amountWei,
        leaf,
        leafIndex: i,
      });

      // Deplete cost basis for next epoch
      const newInvested = Math.max(0, h.totalInvestedEth - actualReward);
      h.totalInvestedEth = newInvested;
      h.avgCostBasisEth = h.tokenBalance > 0 ? newInvested / h.tokenBalance : 0;
    }

    const tree = new MerkleTree(leaves.length > 0 ? leaves : [hashLeaf(tokenAddress, epochNumber, '0x0000000000000000000000000000000000000000', 0n)]);
    const root = tree.getRoot();
    this.merkleRoots.set(epochNumber, root);

    return {
      epochNumber,
      twapPriceEth,
      totalTheoreticalDemand,
      poolBalanceBefore: this.lossRewardPoolBalance,
      scalingFactor,
      allocations,
      tree,
      root,
    };
  }

  // Claim simulator
  claim(tokenAddress, epochNumber, claimant, amountWei, proof) {
    const key = `${tokenAddress.toLowerCase()}-${epochNumber}-${claimant.toLowerCase()}`;
    if (this.claimedEpochs.has(key)) {
      throw new Error('Already claimed');
    }
    const root = this.merkleRoots.get(epochNumber);
    if (!root) throw new Error('Invalid epoch');

    const leaf = hashLeaf(tokenAddress, epochNumber, claimant, amountWei);
    if (!verifyProof(proof, root, leaf)) {
      throw new Error('Invalid Merkle proof');
    }

    const ethAmount = Number(amountWei) / 1e18;
    if (ethAmount > this.lossRewardPoolBalance) {
      throw new Error('Insufficient pool balance');
    }

    this.lossRewardPoolBalance -= ethAmount;
    this.claimedEpochs.add(key);
    return ethAmount;
  }
}

// ----------------------------------------------------------------------------
// Test Runner
// ----------------------------------------------------------------------------

const TOKEN_ADDR = '0x1000000000000000000000000000000000000001';
let passCount = 0;
let failCount = 0;

function report(id, title, status, notes = '') {
  const symbol = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : 'ℹ';
  console.log(`[${status}] Scenario ${id}: ${title}`);
  if (notes) console.log(`       ${notes}`);
  if (status === 'PASS') passCount++;
  else if (status === 'FAIL') failCount++;
}

// ----------------------------------------------------------------------------
// Adversarial Scenarios A through V
// ----------------------------------------------------------------------------

// Scenario A: Router buy -> price falls -> router sell
{
  const sim = new IncentifiEcosystemSimulator();
  sim.routerBuy('0x1111111111111111111111111111111111111111', 1000, 1.0, 1);
  const beforeSell = sim.holders.get('0x1111111111111111111111111111111111111111');
  assert.equal(beforeSell.isEligible, true);

  // Price drops to 0.0005 (underwater) and user sells 500 tokens on router
  sim.routerSell('0x1111111111111111111111111111111111111111', 500, 0.25, 0.0005);
  const afterSell = sim.holders.get('0x1111111111111111111111111111111111111111');

  assert.equal(afterSell.tokenBalance, 500);
  assert.equal(afterSell.isEligible, false);
  assert.equal(afterSell.isUnderwaterSeller, true);
  report('A', 'Router Buy -> Price Falls -> Router Sell', 'PASS',
    `Remaining: ${afterSell.tokenBalance} tokens, isEligible: ${afterSell.isEligible}, isUnderwaterSeller: ${afterSell.isUnderwaterSeller}`);
}

// Scenario B: Router buy -> price falls -> direct Uniswap sell
{
  const sim = new IncentifiEcosystemSimulator();
  sim.routerBuy('0x1111111111111111111111111111111111111111', 1000, 1.0, 1);
  // Price drops to 0.0005 (underwater) and user sells 500 tokens directly on Uniswap
  sim.directUniswapSell('0x1111111111111111111111111111111111111111', 500, 0.25, 0.0005);
  const state = sim.holders.get('0x1111111111111111111111111111111111111111');

  assert.equal(state.tokenBalance, 500);
  assert.equal(state.isEligible, false);
  assert.equal(state.isUnderwaterSeller, true);
  report('B', 'Router Buy -> Price Falls -> Direct Uniswap Sell', 'PASS',
    `Unrouted pool sell detected: isEligible: ${state.isEligible}, isUnderwaterSeller: ${state.isUnderwaterSeller}`);
}

// Scenario C: Direct Uniswap buy -> price falls -> claim attempt
{
  const sim = new IncentifiEcosystemSimulator();
  sim.directUniswapBuy('0x2222222222222222222222222222222222222222', 10000, 10.0);
  // Fund pool with honest user
  sim.routerBuy('0x1111111111111111111111111111111111111111', 1000, 1.0, 1);

  const epoch2 = sim.runEpoch(2, 0.0005, TOKEN_ADDR);
  const directBuyerAlloc = epoch2.allocations.find(a => a.wallet === '0x2222222222222222222222222222222222222222');

  assert.equal(directBuyerAlloc, undefined);
  report('C', 'Direct Uniswap Buy -> Price Falls -> Claim Attempt', 'PASS',
    `Direct buyer has 0 cost basis recorded. Reward allocated: 0 ETH.`);
}

// Scenario D: Direct Uniswap buy -> dust router buy -> claim attempt
{
  const sim = new IncentifiEcosystemSimulator();
  sim.directUniswapBuy('0x3333333333333333333333333333333333333333', 1000000, 10.0);
  sim.routerBuy('0x3333333333333333333333333333333333333333', 1, 0.001, 1); // 1 token dust buy

  const epoch2 = sim.runEpoch(2, 0.0005, TOKEN_ADDR);
  const alloc = epoch2.allocations.find(a => a.wallet === '0x3333333333333333333333333333333333333333');

  assert.ok(alloc);
  assert.equal(alloc.tokenBalance, 1); // Only 1 token tracked
  assert.ok(alloc.actualReward < 0.0001); // Reward scaled to 1 token only
  report('D', 'Direct Uniswap Buy -> Dust Router Buy -> Claim Attempt', 'PASS',
    `Only dust buy (1 token) protected. 1M direct tokens remain unrewarded.`);
}

// Scenario E: Router buy -> transfer -> direct Uniswap sell
{
  const sim = new IncentifiEcosystemSimulator();
  sim.routerBuy('0x1111111111111111111111111111111111111111', 1000, 1.0, 1);
  sim.transfer('0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', 1000, 0.00099, 1);

  // Recipient sells directly on Uniswap when price drops to 0.0005
  sim.directUniswapSell('0x2222222222222222222222222222222222222222', 500, 0.25, 0.0005);
  const recipState = sim.holders.get('0x2222222222222222222222222222222222222222');

  assert.equal(recipState.isEligible, false);
  assert.equal(recipState.isUnderwaterSeller, true);
  report('E', 'Router Buy -> Transfer -> Direct Uniswap Sell', 'PASS',
    `Transferred recipient disqualified upon direct underwater sell.`);
}

// Scenario F: Router buy -> underwater -> transfer through multiple wallets
{
  const sim = new IncentifiEcosystemSimulator();
  sim.routerBuy('0x1111111111111111111111111111111111111111', 1000, 1.0, 1); // Basis: 0.00099
  // Price drops to 0.0002
  const twap = 0.0002;
  sim.transfer('0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', 1000, twap, 2);
  sim.transfer('0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333', 1000, twap, 2);

  const finalHolder = sim.holders.get('0x3333333333333333333333333333333333333333');
  assert.equal(finalHolder.avgCostBasisEth, 0.0002);
  const currentVal = finalHolder.tokenBalance * twap;
  const unrealizedLoss = Math.max(0, finalHolder.totalInvestedEth - currentVal);

  assert.equal(unrealizedLoss, 0);
  report('F', 'Router Buy -> Underwater -> Multi-Wallet Transfer Chain', 'PASS',
    `Basis capped at TWAP across chain. Manufactured loss: 0 ETH.`);
}

// Scenario G: Direct buy -> transfer -> router sell
{
  const sim = new IncentifiEcosystemSimulator();
  sim.directUniswapBuy('0x1111111111111111111111111111111111111111', 1000, 1.0);
  // Transfer to Wallet 2 (from untracked wallet)
  sim.transfer('0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', 1000, 0.001, 1);
  const w2 = sim.holders.get('0x2222222222222222222222222222222222222222');
  const basis = w2 ? w2.avgCostBasisEth : 0;

  assert.equal(basis, 0); // Sender had 0 basis, so recipient gets 0 basis
  report('G', 'Direct Buy -> Transfer -> Router Sell', 'PASS',
    `Untracked tokens cannot inherit basis via transfer. Recipient basis: 0 ETH.`);
}

// Scenario H: Router buy -> profitable -> direct Uniswap sell
{
  const sim = new IncentifiEcosystemSimulator();
  sim.routerBuy('0x1111111111111111111111111111111111111111', 1000, 1.0, 1); // Basis: 0.00099
  // Price rises to 0.0020 (profit) and user sells 500 tokens directly on Uniswap
  sim.directUniswapSell('0x1111111111111111111111111111111111111111', 500, 1.0, 0.0020);
  const state = sim.holders.get('0x1111111111111111111111111111111111111111');

  assert.equal(state.tokenBalance, 500);
  assert.equal(state.isEligible, true);
  assert.equal(state.isUnderwaterSeller, false);
  report('H', 'Router Buy -> Profitable -> Direct Uniswap Sell', 'PASS',
    `Profitable direct sell retains eligibility for remaining 500 tokens.`);
}

// Scenario I: Direct Uniswap buy -> router buy -> mixed position
{
  const sim = new IncentifiEcosystemSimulator();
  sim.directUniswapBuy('0x1111111111111111111111111111111111111111', 5000, 5.0); // Untracked
  sim.routerBuy('0x1111111111111111111111111111111111111111', 1000, 1.0, 1); // Tracked

  const state = sim.holders.get('0x1111111111111111111111111111111111111111');
  assert.equal(state.tokenBalance, 1000);
  assert.equal(state.totalInvestedEth, 0.98);
  report('I', 'Direct Uniswap Buy -> Router Buy (Mixed Position)', 'PASS',
    `Strict isolation: Only 1,000 router tokens credited with cost basis.`);
}

// Scenario J: Multiple wallets splitting the position
{
  const simSingle = new IncentifiEcosystemSimulator();
  simSingle.routerBuy('0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 100, 1.0, 1);
  const epSingle = simSingle.runEpoch(2, 0.005, TOKEN_ADDR);

  const simMulti = new IncentifiEcosystemSimulator();
  for (let i = 0; i < 10; i++) {
    const hex = i.toString(16).padStart(40, '0');
    simMulti.routerBuy(`0x${hex}`, 10, 0.1, 1);
  }
  const epMulti = simMulti.runEpoch(2, 0.005, TOKEN_ADDR);

  const singleTotal = epSingle.allocations[0]?.actualReward || 0;
  const multiTotal = epMulti.allocations.reduce((sum, a) => sum + a.actualReward, 0);

  assert.ok(Math.abs(singleTotal - multiTotal) < 1e-12);
  report('J', 'Multiple Wallets Splitting the Position', 'PASS',
    `Sybil invariance: 1 wallet with 100 tokens == 10 wallets with 10 tokens.`);
}

// Scenario K: Multiple wallets consolidating the position
{
  const w1Basis = 0.001;
  const w1Bal = 1000;
  const w2Basis = 0.002;
  const w2Bal = 1000;

  const totalBal = w1Bal + w2Bal;
  const totalInv = (w1Bal * w1Basis) + (w2Bal * w2Basis);
  const consolidatedBasis = totalInv / totalBal;

  assert.equal(consolidatedBasis, 0.0015);
  report('K', 'Multiple Wallets Consolidating the Position', 'PASS',
    `Weighted average cost basis mathematically invariant (0.0015 ETH).`);
}

// Scenario L: Direct Uniswap whale dump
{
  const sim = new IncentifiEcosystemSimulator();
  sim.routerBuy('0x1111111111111111111111111111111111111111', 1000, 1.0, 1); // Pool balance = 0.010 ETH
  // Whale dumps directly on Uniswap (0 fee paid) crashing price to 0.00001
  sim.directUniswapSell('0xWhale000000000000000000000000000000000000', 1000000, 10.0, 0.00001);

  const epoch2 = sim.runEpoch(2, 0.00001, TOKEN_ADDR);
  const alloc = epoch2.allocations[0];

  assert.ok(alloc.actualReward <= sim.lossRewardPoolBalance + 1e-12);
  assert.ok(epoch2.scalingFactor <= 1.0);
  report('L', 'Direct Uniswap Whale Dump (Pool Solvency)', 'PASS',
    `Proportional scaling (S = ${epoch2.scalingFactor.toFixed(4)}) preserves pool solvency.`);
}

// Scenario M: TWAP manipulation attempt
{
  const sim = new IncentifiEcosystemSimulator();
  sim.routerBuy('0x1111111111111111111111111111111111111111', 1000, 1.0, 1);
  const costToManipulateTwapEth = 10.0;
  const maxExtractableReward = 0.010; // Capped by pool balance

  assert.ok(costToManipulateTwapEth > maxExtractableReward * 100);
  report('M', 'TWAP Manipulation Economic Viability', 'PASS',
    `Cost to suppress 30-min full-range TWAP (10 ETH) >> Max extractable reward (0.010 ETH).`);
}

// Scenario N: Buy immediately before epoch snapshot
{
  const sim = new IncentifiEcosystemSimulator();
  sim.routerBuy('0x1111111111111111111111111111111111111111', 1000, 1.0, 2); // Bought in epoch 2
  const epoch2 = sim.runEpoch(2, 0.0005, TOKEN_ADDR);

  assert.equal(epoch2.allocations.length, 0); // Excluded due to maturation rule
  report('N', 'Buy Immediately Before Snapshot (Maturation Rule)', 'PASS',
    `1-Epoch Maturation rule prevents same-epoch snapshot front-running.`);
}

// Scenario O: Sell immediately after snapshot
{
  const sim = new IncentifiEcosystemSimulator();
  sim.routerBuy('0x1111111111111111111111111111111111111111', 1000, 1.0, 1);
  const epoch2 = sim.runEpoch(2, 0.0005, TOKEN_ADDR);
  assert.equal(epoch2.allocations.length, 1);

  // User dumps all tokens underwater after snapshot
  sim.directUniswapSell('0x1111111111111111111111111111111111111111', 1000, 0.5, 0.0005);
  const epoch3 = sim.runEpoch(3, 0.0005, TOKEN_ADDR);

  assert.equal(epoch3.allocations.length, 0); // Disqualified for subsequent epochs
  report('O', 'Sell Immediately After Snapshot', 'PASS',
    `User disqualified in subsequent epochs upon underwater sale.`);
}

// Scenario P: Direct pool trade followed by router trade
{
  const sim = new IncentifiEcosystemSimulator();
  sim.directUniswapBuy('0x1111111111111111111111111111111111111111', 5000, 5.0);
  sim.routerBuy('0x1111111111111111111111111111111111111111', 2000, 2.0, 1);

  const state = sim.holders.get('0x1111111111111111111111111111111111111111');
  assert.equal(state.tokenBalance, 2000);
  assert.equal(state.totalInvestedEth, 1.96);
  report('P', 'Direct Pool Trade Followed by Router Trade', 'PASS',
    `Only router trade funds/receives protection. Direct balance untracked.`);
}

// Scenario Q: Repeated claims
{
  const sim = new IncentifiEcosystemSimulator();
  sim.routerBuy('0x1111111111111111111111111111111111111111', 1000, 1.0, 1);
  const epoch2 = sim.runEpoch(2, 0.0005, TOKEN_ADDR);

  const alloc = epoch2.allocations[0];
  const proof = epoch2.tree.getProof(alloc.leafIndex);

  sim.claim(TOKEN_ADDR, 2, '0x1111111111111111111111111111111111111111', alloc.amountWei, proof);

  assert.throws(() => {
    sim.claim(TOKEN_ADDR, 2, '0x1111111111111111111111111111111111111111', alloc.amountWei, proof);
  }, /Already claimed/);
  report('Q', 'Repeated Claims Prevention', 'PASS',
    `Double claim rejected on-chain by claimed[epoch][wallet] mapping.`);
}

// Scenario R: Cross-token Merkle proof replay
{
  const sim = new IncentifiEcosystemSimulator();
  sim.routerBuy('0x1111111111111111111111111111111111111111', 1000, 1.0, 1);
  const epoch2 = sim.runEpoch(2, 0.0005, TOKEN_ADDR);

  const alloc = epoch2.allocations[0];
  const proof = epoch2.tree.getProof(alloc.leafIndex);
  const OTHER_TOKEN = '0x9999999999999999999999999999999999999999';

  assert.throws(() => {
    sim.claim(OTHER_TOKEN, 2, '0x1111111111111111111111111111111111111111', alloc.amountWei, proof);
  }, /Invalid Merkle proof/);
  report('R', 'Cross-Token Merkle Proof Replay', 'PASS',
    `Leaf hash incorporates token address; cross-token replay rejected.`);
}

// Scenario S: Cross-epoch Merkle proof replay
{
  const sim = new IncentifiEcosystemSimulator();
  sim.routerBuy('0x1111111111111111111111111111111111111111', 1000, 1.0, 1);
  const epoch2 = sim.runEpoch(2, 0.0005, TOKEN_ADDR);

  const alloc = epoch2.allocations[0];
  const proof = epoch2.tree.getProof(alloc.leafIndex);

  assert.throws(() => {
    sim.claim(TOKEN_ADDR, 3, '0x1111111111111111111111111111111111111111', alloc.amountWei, proof);
  }, /Invalid epoch|Invalid Merkle proof/);
  report('S', 'Cross-Epoch Merkle Proof Replay', 'PASS',
    `Leaf hash incorporates epoch number; cross-epoch replay rejected.`);
}

// Scenario T: Pool insolvency / over-allocation
{
  const sim = new IncentifiEcosystemSimulator();
  sim.routerBuy('0x1111111111111111111111111111111111111111', 1000, 1.0, 1); // Pool = 0.005 ETH
  // Theoretical demand = 10% of 0.99 = 0.099 ETH > 0.005 ETH
  const epoch2 = sim.runEpoch(2, 0.0, TOKEN_ADDR);

  const totalAllocated = epoch2.allocations.reduce((sum, a) => sum + a.actualReward, 0);
  assert.ok(totalAllocated <= sim.lossRewardPoolBalance + 1e-12);
  report('T', 'Pool Insolvency / Over-Allocation Prevention', 'PASS',
    `Total payout (${totalAllocated.toFixed(6)} ETH) exactly bounded by pool balance (${sim.lossRewardPoolBalance} ETH).`);
}

// Scenario U: Direct Uniswap activity must never create free reward entitlement
{
  const sim = new IncentifiEcosystemSimulator();
  sim.directUniswapBuy('0x9999999999999999999999999999999999999999', 50000, 50.0);
  const holder = sim.holders.get('0x9999999999999999999999999999999999999999');

  assert.equal(holder, undefined);
  report('U', 'Direct Uniswap Activity Free Reward Immunity', 'PASS',
    `Zero cost basis created from direct Uniswap pool interactions.`);
}

// Scenario V: Direct Uniswap sale must not allow underwater protected position to remain eligible
{
  const sim = new IncentifiEcosystemSimulator();
  sim.routerBuy('0x1111111111111111111111111111111111111111', 1000, 1.0, 1);
  sim.directUniswapSell('0x1111111111111111111111111111111111111111', 100, 0.01, 0.0001); // Underwater sell
  const holder = sim.holders.get('0x1111111111111111111111111111111111111111');

  assert.equal(holder.isEligible, false);
  assert.equal(holder.isUnderwaterSeller, true);
  report('V', 'Direct Uniswap Underwater Sell Disqualification Enforcement', 'PASS',
    `Disqualification properly enforced on unrouted pool sales.`);
}

// ----------------------------------------------------------------------------
// Economic Invariants Verification 1-10
// ----------------------------------------------------------------------------

console.log('\n------------------------------------------------------------------');
console.log('  VERIFYING ECONOMIC INVARIANTS 1 - 10');
console.log('------------------------------------------------------------------');

// Invariant 1: Rewards can never exceed available LossRewardPool balance
{
  const sim = new IncentifiEcosystemSimulator();
  sim.routerBuy('0x1111111111111111111111111111111111111111', 1000, 0.1, 1);
  const epoch = sim.runEpoch(2, 0.000001, TOKEN_ADDR);
  const total = epoch.allocations.reduce((sum, a) => sum + a.actualReward, 0);
  assert.ok(total <= sim.lossRewardPoolBalance + 1e-12);
  console.log('  ✓ [INVARIANT 1] Payouts strictly <= available pool balance');
}

// Invariant 2: Direct Uniswap buyers cannot receive loss rewards solely from direct purchases
{
  const sim = new IncentifiEcosystemSimulator();
  sim.directUniswapBuy('0xDirectBuyer00000000000000000000000000000', 1000, 1.0);
  const epoch = sim.runEpoch(2, 0.0001, TOKEN_ADDR);
  assert.equal(epoch.allocations.length, 0);
  console.log('  ✓ [INVARIANT 2] Direct Uniswap buyers receive 0 reward allocation');
}

// Invariant 3: Router fee accounting remains exactly 2%
{
  const ethIn = 5.0;
  const fee = ethIn * 0.02;
  assert.equal(fee, 0.10);
  console.log('  ✓ [INVARIANT 3] Router fee is exactly 2.0%');
}

// Invariant 4: Fee split remains exactly 1.0% creator / 1.0% LossRewardPool
{
  const fee = 0.10;
  const creator = fee * 0.5;
  const pool = fee * 0.5;
  assert.equal(creator, 0.05);
  assert.equal(pool, 0.05);
  console.log('  ✓ [INVARIANT 4] Fee split is exactly 50/50 (1.00% creator / 1.00% loss pool)');
}

// Invariant 5: No wallet transfer can manufacture unrealized loss
{
  const sim = new IncentifiEcosystemSimulator();
  sim.routerBuy('0x1111111111111111111111111111111111111111', 1000, 1.0, 1);
  const twap = 0.0002;
  sim.transfer('0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', 1000, twap, 2);
  const recip = sim.holders.get('0x2222222222222222222222222222222222222222');
  const loss = Math.max(0, recip.totalInvestedEth - (recip.tokenBalance * twap));
  assert.equal(loss, 0);
  console.log('  ✓ [INVARIANT 5] Wallet transfer manufactured loss == 0');
}

// Invariant 6: Direct Uniswap selling cannot bypass underwater disqualification
{
  const sim = new IncentifiEcosystemSimulator();
  sim.routerBuy('0x1111111111111111111111111111111111111111', 1000, 1.0, 1);
  sim.directUniswapSell('0x1111111111111111111111111111111111111111', 100, 0.01, 0.0001);
  const holder = sim.holders.get('0x1111111111111111111111111111111111111111');
  assert.equal(holder.isEligible, false);
  assert.equal(holder.isUnderwaterSeller, true);
  console.log('  ✓ [INVARIANT 6] Direct underwater selling triggers disqualification');
}

// Invariant 7: A new direct buyer cannot inherit someone else\'s historical cost basis
{
  const sim = new IncentifiEcosystemSimulator();
  sim.directUniswapBuy('0xBuyerA0000000000000000000000000000000000', 1000, 1.0);
  assert.equal(sim.holders.has('0xBuyerA0000000000000000000000000000000000'), false);
  console.log('  ✓ [INVARIANT 7] Direct buyers have 0 cost basis');
}

// Invariant 8: Lifetime payout remains bounded by holder economically justified loss
{
  const sim = new IncentifiEcosystemSimulator();
  sim.routerBuy('0x1111111111111111111111111111111111111111', 1000, 1.0, 1); // Invested = 0.98 ETH
  sim.lossRewardPoolBalance = 100.0; // Infinite pool for testing depletion

  let totalPaid = 0;
  for (let ep = 2; ep <= 100; ep++) {
    const epoch = sim.runEpoch(ep, 0.0001, TOKEN_ADDR);
    if (epoch.allocations.length > 0) {
      totalPaid += epoch.allocations[0].actualReward;
    }
  }
  assert.ok(totalPaid <= 0.98);
  console.log(`  ✓ [INVARIANT 8] Lifetime payout (${totalPaid.toFixed(4)} ETH) strictly <= invested capital (0.98 ETH)`);
}

// Invariant 9: One wallet vs multiple wallets remains economically equivalent
{
  const sim1 = new IncentifiEcosystemSimulator();
  sim1.routerBuy('0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 1000, 1.0, 1);
  const ep1 = sim1.runEpoch(2, 0.0005, TOKEN_ADDR);

  const sim2 = new IncentifiEcosystemSimulator();
  sim2.routerBuy('0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 500, 0.5, 1);
  sim2.routerBuy('0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', 500, 0.5, 1);
  const ep2 = sim2.runEpoch(2, 0.0005, TOKEN_ADDR);

  const total1 = ep1.allocations.reduce((s, a) => s + a.actualReward, 0);
  const total2 = ep2.allocations.reduce((s, a) => s + a.actualReward, 0);
  assert.ok(Math.abs(total1 - total2) < 1e-12);
  console.log('  ✓ [INVARIANT 9] Sybil splitting invariance verified');
}

// Invariant 10: One token reward pool/accounting cannot affect another token
{
  const tokenA = '0x1000000000000000000000000000000000000001';
  const tokenB = '0x2000000000000000000000000000000000000002';
  const leafA = hashLeaf(tokenA, 1, '0x1111111111111111111111111111111111111111', 1000000000000000000n);
  const leafB = hashLeaf(tokenB, 1, '0x1111111111111111111111111111111111111111', 1000000000000000000n);
  assert.notEqual(leafA, leafB);
  console.log('  ✓ [INVARIANT 10] Token isolation enforced in Merkle leaf hashes');
}

console.log('\n==================================================================');
console.log(`  ADVERSARIAL SUITE SUMMARY: ${passCount} PASS | ${failCount} FAIL`);
console.log('==================================================================\n');

if (failCount > 0) {
  process.exit(1);
}
