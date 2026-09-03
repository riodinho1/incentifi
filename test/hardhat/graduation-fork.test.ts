import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { parseEther, parseAbi, getAddress, toHex } from 'viem';

/**
 * Forks Robinhood Chain mainnet and validates a full bonding-curve-to-Uniswap-V3
 * graduation lifecycle end-to-end against the REAL, live Uniswap V3 deployment
 * (Factory, PositionManager, SwapRouter02, WETH) — the only genuinely realistic way
 * to confirm this without risking real funds on mainnet.
 *
 * Deploys FRESH instances of IncentifiBondingCurveFactory / IncentifiSwapRouter from
 * this repo's current (fixed) source, wired to the real Uniswap/WETH/LossRewardPool
 * addresses already live on the fork. This is deliberate: the already-deployed
 * Incentifi contracts on-chain still run the OLD, unfixed bytecode (graduation price
 * bug, push-payment creator fee) — this test exists to validate the FIX, which only
 * exists in this repo's source so far.
 *
 * Run with: npx hardhat test nodejs --network robinhoodFork
 * Requires network access to the Robinhood Chain RPC (override with ROBINHOOD_RPC_URL).
 */

const WETH = getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
const UNISWAP_V3_FACTORY = getAddress('0x1f7d7550B1b028f7571E69A784071F0205FD2EfA');
const UNISWAP_POSITION_MANAGER = getAddress('0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3');
const UNISWAP_SWAP_ROUTER02 = getAddress('0xcaf681a66D020601342297493863e78C959e5Cb2');
const LOSS_REWARD_POOL = getAddress('0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf');
const DEAD_ADDRESS = getAddress('0x000000000000000000000000000000000000dEaD');
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const UNISWAP_V3_FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
]);
const ERC721_ABI = parseAbi(['function ownerOf(uint256 tokenId) view returns (address)']);
const UNISWAP_V3_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
]);
const WETH_ABI = parseAbi([
  'function deposit() payable',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
]);
const SWAP_ROUTER02_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);

describe('Graduation fork test (Robinhood Chain mainnet fork)', () => {
  it('runs a full bonding-curve-to-Uniswap-V3 graduation lifecycle end-to-end', async () => {
    const { viem, networkHelpers } = await network.create('robinhoodFork');
    const publicClient = await viem.getPublicClient();

    console.log('--- Fork setup ---');
    console.log('Forked at block:', await publicClient.getBlockNumber());
    for (const [name, addr] of [
      ['WETH', WETH],
      ['Uniswap V3 Factory', UNISWAP_V3_FACTORY],
      ['Uniswap V3 PositionManager', UNISWAP_POSITION_MANAGER],
      ['Uniswap V3 SwapRouter02', UNISWAP_SWAP_ROUTER02],
      ['LossRewardPool', LOSS_REWARD_POOL],
    ] as const) {
      const code = await publicClient.getCode({ address: addr });
      assert.ok(code && code !== '0x', `${name} must have deployed code on the fork`);
      console.log(`  ${name}: deployed (${((code.length - 2) / 2)} bytes)`);
    }

    const [, creator, trader1, trader2, trader3, genericBot] = await viem.getWalletClients();
    for (const wallet of [creator, trader1, trader2, trader3, genericBot]) {
      await networkHelpers.setBalance(wallet.account.address, parseEther('1000'));
    }

    // Deploy FIXED Incentifi contracts fresh, pointed at the real live Uniswap/WETH/LossRewardPool.
    const factory = await viem.deployContract('IncentifiBondingCurveFactory', [
      LOSS_REWARD_POOL,
      WETH,
      UNISWAP_POSITION_MANAGER,
      UNISWAP_V3_FACTORY,
    ]);
    const router = await viem.deployContract('IncentifiSwapRouter', [
      UNISWAP_SWAP_ROUTER02,
      WETH,
      LOSS_REWARD_POOL,
      factory.address,
    ]);
    console.log('--- Fresh (fixed) Incentifi deployment ---');
    console.log('IncentifiBondingCurveFactory:', factory.address);
    console.log('IncentifiSwapRouter:         ', router.address);

    // Launch a fresh test token as `creator`.
    const totalSupply = 1_000_000_000n * 10n ** 18n;
    const token = await viem.deployContract('IncentifiLaunchToken', ['Fork Test Token', 'FORK', totalSupply], {
      client: { wallet: creator },
    });
    await publicClient.waitForTransactionReceipt({
      hash: await token.write.approve([factory.address, totalSupply], { account: creator.account }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await factory.write.registerExistingToken([token.address, creator.account.address], {
        account: creator.account,
      }),
    });

    const curveAddr = await factory.read.getBondingCurve([token.address]);
    assert.notEqual(curveAddr, ZERO_ADDRESS, 'factory must have registered a bonding curve');
    const curve = await viem.getContractAt('IncentifiBondingCurve', curveAddr);
    console.log('Token deployed at:      ', token.address);
    console.log('Bonding curve deployed: ', curveAddr);

    // --- Step 1: buys from multiple simulated traders up to graduation ---
    const traders = [trader1, trader2, trader3];
    let buyCount = 0;
    let totalGasUsedBuys = 0n;

    while (!(await curve.read.graduated())) {
      const trader = traders[buyCount % 3];
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
      const hash = await router.write.buyToken([token.address, 0n, deadline], {
        account: trader.account,
        value: parseEther('2'),
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      totalGasUsedBuys += receipt.gasUsed;
      buyCount++;
      assert.ok(buyCount < 20, 'did not graduate within a reasonable number of buys');
    }

    console.log('--- Graduation ---');
    console.log('Buys until graduation:      ', buyCount);
    console.log('Total gas across all buys:  ', totalGasUsedBuys.toString());
    console.log('Avg gas per buy:            ', (totalGasUsedBuys / BigInt(buyCount)).toString());

    // --- Step 2: confirm _graduate() actually fired and created a real pool ---
    assert.equal(await curve.read.graduated(), true, 'curve must report graduated');
    const poolAddr = getAddress(await curve.read.uniswapPool());
    assert.notEqual(poolAddr, ZERO_ADDRESS, 'graduation must create a Uniswap V3 pool');
    const poolCode = await publicClient.getCode({ address: poolAddr });
    assert.ok(poolCode && poolCode !== '0x', 'pool address must have real deployed code');
    console.log('Graduated pool address:     ', poolAddr);

    // Cross-check: the pool must be independently discoverable via the REAL, unmodified
    // Uniswap V3 Factory's own getPool() — proving Factory registration actually happened
    // inside createAndInitializePoolIfNecessary(), not just that our code assumes it did.
    const poolFromFactory = await publicClient.readContract({
      address: UNISWAP_V3_FACTORY,
      abi: UNISWAP_V3_FACTORY_ABI,
      functionName: 'getPool',
      args: [token.address, WETH, 10000],
    });
    assert.equal(
      getAddress(poolFromFactory),
      poolAddr,
      'pool must be discoverable via the real UniswapV3Factory.getPool()'
    );
    console.log('Confirmed via real UniswapV3Factory.getPool(): MATCH');

    // --- Step 2b: confirm the LP NFT was burned to 0xdead atomically ---
    const lpTokenId = await curve.read.lpTokenId();
    const nftOwner = await publicClient.readContract({
      address: UNISWAP_POSITION_MANAGER,
      abi: ERC721_ABI,
      functionName: 'ownerOf',
      args: [lpTokenId],
    });
    assert.equal(getAddress(nftOwner), DEAD_ADDRESS, 'LP NFT must be burned to the dead address');
    console.log('LP NFT tokenId', lpTokenId.toString(), 'confirmed burned to 0xdead');

    // --- Step 3: price continuity — pool's real slot0() price vs. curve's final price ---
    const curvePriceEthPerToken = await curve.read.getCurrentPrice(); // wei ETH per token, 1e18-scaled
    const slot0 = await publicClient.readContract({ address: poolAddr, abi: UNISWAP_V3_POOL_ABI, functionName: 'slot0' });
    const token0 = getAddress(
      await publicClient.readContract({ address: poolAddr, abi: UNISWAP_V3_POOL_ABI, functionName: 'token0' })
    );
    const sqrtPriceX96 = slot0[0];

    // xScaled = (sqrtPriceX96 / 2^96) * 1e18, computed as an intermediate integer to avoid
    // the overflow that sqrtPriceX96^2 * 1e18 would hit directly.
    const xScaled = (sqrtPriceX96 * 10n ** 18n) / (1n << 96n);
    const token1PerToken0Scaled = (xScaled * xScaled) / 10n ** 18n;
    const poolPriceEthPerToken = token0 === WETH ? 10n ** 36n / token1PerToken0Scaled : token1PerToken0Scaled;

    const diff =
      poolPriceEthPerToken > curvePriceEthPerToken
        ? poolPriceEthPerToken - curvePriceEthPerToken
        : curvePriceEthPerToken - poolPriceEthPerToken;
    const diffPpm = (diff * 1_000_000n) / curvePriceEthPerToken;

    console.log('--- Price continuity ---');
    console.log('token0 == WETH?             ', token0 === WETH);
    console.log('Curve final price (wei/tok):', curvePriceEthPerToken.toString());
    console.log('Pool slot0 price (wei/tok): ', poolPriceEthPerToken.toString());
    console.log('Difference (parts-per-million):', diffPpm.toString());

    assert.ok(diffPpm < 100n, `pool price diff ${diffPpm} ppm exceeds the 100 ppm (0.01%) tolerance`);

    // --- Step 4: a generic bot swap — RAW SwapRouter02 call, zero knowledge of
    // Incentifi's contracts, exactly what GMGN/Photon/etc. would do. ---
    const swapAmountIn = parseEther('0.05');
    await publicClient.waitForTransactionReceipt({
      hash: await genericBot.writeContract({ address: WETH, abi: WETH_ABI, functionName: 'deposit', value: swapAmountIn }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await genericBot.writeContract({
        address: WETH,
        abi: WETH_ABI,
        functionName: 'approve',
        args: [UNISWAP_SWAP_ROUTER02, swapAmountIn],
      }),
    });

    const swapHash = await genericBot.writeContract({
      address: UNISWAP_SWAP_ROUTER02,
      abi: SWAP_ROUTER02_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: WETH,
          tokenOut: token.address,
          fee: 10000,
          recipient: genericBot.account.address,
          amountIn: swapAmountIn,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });

    const botTokenBalance = await token.read.balanceOf([genericBot.account.address]);

    console.log('--- Generic bot swap (raw SwapRouter02, no Incentifi-specific knowledge) ---');
    console.log('Swap input (wei WETH):      ', swapAmountIn.toString());
    console.log('Swap output (wei token):    ', botTokenBalance.toString());
    console.log('Gas used for swap:          ', swapReceipt.gasUsed.toString());

    assert.ok(botTokenBalance > 0n, 'generic bot swap must produce a non-zero, non-reverting quote');

    // --- Step 5: creator pull-payment — claim fees accrued from BOTH pre- and
    // post-graduation trades, via the router's fixed _sendCreatorFee(). ---
    // One more buy, now post-graduation and through IncentifiSwapRouter (not the raw
    // generic-bot swap above), to generate a genuine post-graduation creator-fee credit
    // via the router's depositCreatorFee() path, alongside the 3 pre-graduation ones
    // already accrued during the graduation buys.
    // Work around a Hardhat 3 EDR fork quirk ("metadata is not found") hit when a
    // remote-forked contract's storage slot is accessed for the very first time at a
    // local block height past the pinned fork block. The router has never touched WETH
    // before this point (the graduation buys went through the curve, not this router's
    // Uniswap branch), so its WETH balanceOf slot has never been fetched from the fork.
    // Confirmed via direct experiment: this specific WETH deployment's storage layout
    // does not match canonical WETH9 (balanceOf is not at the textbook slot 3), so the
    // slot below was taken directly from the RPC error EDR itself reports when the
    // router's first-ever WETH read/write is attempted — it is deterministic for this
    // router's address on this pinned fork block, confirmed identical across repeated
    // runs. Pre-seeding it to its real value (0, since the router has never held WETH)
    // gives EDR a locally-known value before that first real interaction.
    const wethSlotsToWarm = [
      '0x7e33b8ed7d1098e60cf06b18d65fed8aacf301f0d6ad62eee270bb5ac201fa54',
      '0x3e85583e0ee2e1dc137ca19061397d318d6ec65576c2bcf31e71b67fd494a5dc',
    ];
    for (const slot of wethSlotsToWarm) {
      await networkHelpers.setStorageAt(WETH, slot, toHex(0n, { size: 32 }));
    }

    const postGradBuyHash = await router.write.buyToken(
      [token.address, 0n, BigInt(Math.floor(Date.now() / 1000) + 300)],
      { account: trader1.account, value: parseEther('1'), gas: 1_000_000n }
    );
    await publicClient.waitForTransactionReceipt({ hash: postGradBuyHash });

    const accruedBeforeClaim = await curve.read.creatorBalances([creator.account.address]);
    assert.ok(
      accruedBeforeClaim > 0n,
      'creator must have a non-zero balance accrued from both pre- and post-graduation trades'
    );

    const creatorEthBefore = await publicClient.getBalance({ address: creator.account.address });
    const claimHash = await curve.write.claimCreatorFees({ account: creator.account });
    const claimReceipt = await publicClient.waitForTransactionReceipt({ hash: claimHash });
    const claimGasCost = claimReceipt.gasUsed * claimReceipt.effectiveGasPrice;
    const creatorEthAfter = await publicClient.getBalance({ address: creator.account.address });
    const accruedAfterClaim = await curve.read.creatorBalances([creator.account.address]);

    console.log('--- Creator pull-payment claim (pre- + post-graduation fees) ---');
    console.log('Accrued before claim (wei):  ', accruedBeforeClaim.toString());
    console.log('Accrued after claim (wei):   ', accruedAfterClaim.toString());
    console.log('Claim tx gas used:           ', claimReceipt.gasUsed.toString());
    console.log(
      'Creator ETH balance delta (net of its own claim-tx gas):',
      (creatorEthAfter - creatorEthBefore + claimGasCost).toString(),
      'wei'
    );

    assert.equal(accruedAfterClaim, 0n, 'creatorBalances must be zeroed after a successful claim');
    assert.equal(
      creatorEthAfter - creatorEthBefore + claimGasCost,
      accruedBeforeClaim,
      "creator's ETH balance must increase by exactly the claimed amount, net of the claim tx's own gas"
    );

    // --- Step 6: indexer freshness gate — confirm the REAL exported worker function
    // refuses to run a snapshot for THIS real, live, freshly-graduated fork token when
    // the indexer heartbeat is stale, not just against a hand-rolled logic mirror. ---
    const originalFetch = globalThis.fetch;
    const originalSupabaseUrl = process.env.SUPABASE_URL;
    const originalSupabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    let freshnessGateResult: any;
    try {
      process.env.SUPABASE_URL = 'https://example.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-role-key-for-fork-test';

      const staleUpdatedAt = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 minutes stale
      globalThis.fetch = (async (input: any, _init?: any) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('/rest/v1/indexer_heartbeats')) {
          return new Response(
            JSON.stringify({
              worker_name: 'evm-indexer',
              status: 'ok',
              message: 'Indexed through block 999999 (simulated)',
              updated_at: staleUpdatedAt,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        throw new Error(`Unexpected fetch during indexer-freshness fork test: ${url}`);
      }) as typeof fetch;

      // Dynamic import AFTER setting env vars: scripts/loss-reward-worker.mjs reads
      // SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY at module-evaluation time.
      const workerModule = await import('../../scripts/loss-reward-worker.mjs');
      freshnessGateResult = await workerModule.executeEpochForToken(token.address, { dryRun: true });

      console.log('--- Indexer freshness gate (real executeEpochForToken(), real graduated token) ---');
      console.log('Token used:                 ', token.address);
      console.log('Simulated heartbeat updated_at:', staleUpdatedAt, '(10 minutes stale)');
      console.log('executeEpochForToken result:', JSON.stringify(freshnessGateResult));
    } finally {
      globalThis.fetch = originalFetch;
      if (originalSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = originalSupabaseUrl;
      if (originalSupabaseKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = originalSupabaseKey;
    }

    assert.equal(freshnessGateResult.skipped, true, 'snapshot must be skipped when the indexer heartbeat is stale');
    assert.equal(freshnessGateResult.reason, 'indexer_stale');
    assert.ok(freshnessGateResult.ageSeconds > 100, 'reported staleness age must reflect the ~600s-stale heartbeat');

    console.log('--- RESULT: full graduation lifecycle, creator claim, and freshness gate all behave as expected ---');
  });
});
