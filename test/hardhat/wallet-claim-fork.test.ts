import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import http from 'node:http';
import fs from 'node:fs';
import { parseEther, getAddress, keccak256, encodeAbiParameters, parseAbiParameters, formatEther } from 'viem';
import { createServer as createViteServer } from 'vite';
import { createClient } from '@supabase/supabase-js';

/**
 * WALLET-SIGNED CLAIM — fork test for src/lib/lossReward.ts claimBatchRewards().
 *
 * The bug this replaces: the gateway's "gasless" /claim relayed claimBatch from the OPERATOR
 * wallet, but LossRewardPool binds each Merkle leaf and the payout to msg.sender — so it reverted
 * InvalidProof for every wallet except the operator itself (the only wallet that ever claimed).
 *
 * What is REAL here: the production LossRewardPool at its real address on a mainnet fork, the
 * real, unmodified frontend module (loaded through Vite SSR exactly as scripts/evm-indexer.mjs
 * loads bondingCurveV4.ts), real eth_sendTransaction transactions signed by the fork's accounts,
 * real receipts, and exact wei balance deltas net of gas. The only stand-in is `window.ethereum`:
 * a minimal EIP-1193 object that answers account/chain queries and forwards everything else
 * (eth_sendTransaction included) to the fork — i.e. what a wallet extension does, minus the popup.
 *
 * Scenario B (always runs): the impersonated pool OWNER publishes synthetic epochs whose single
 * leaf belongs to a fresh test wallet; that wallet claims them through the real function —
 * batch (2 epochs, claimBatch path), single (claimReward path), double-claim (must short-circuit
 * as alreadyClaimed with NO transaction), wrong-active-account (must refuse before any tx).
 *
 * Scenario A (runs when possible): the REAL holder 0xba69…5cE claims its REAL published TESTINGG
 * epochs — amounts/proofs read from production Supabase (read-only) — impersonated on the fork.
 * Skipped with a clear message if the holder already claimed on mainnet before the fork block.
 *
 * Run (isolated — node:test shares a process across files):
 *   npx hardhat test nodejs --network robinhoodFork -- test/hardhat/wallet-claim-fork.test.ts
 */

const POOL = getAddress('0x697BDA9db5a297a9Cd9ED969BBF2549d0527DcdF');
const OWNER = getAddress('0x78a4E4BCC8ab559B6d3B1Cb9eab0A04a2411c726'); // owner == operator on the real pool
const TESTINGG = getAddress('0x7F9b8A09877F6e8096b0b8c6027DC49580b05474');
const HOLDER = getAddress('0xba69Ca72CD2B87113471c4C38f08928761Edb5cE');

// Exactly LossRewardPool._claimEpoch's leaf: keccak256(bytes.concat(keccak256(abi.encode(token, epochId, claimant, amount))))
const leafFor = (token: `0x${string}`, epochId: bigint, claimant: `0x${string}`, amount: bigint) =>
  keccak256(keccak256(encodeAbiParameters(parseAbiParameters('address,uint256,address,uint256'), [token, epochId, claimant, amount])));

// Hardhat/EDR surfaces revert bytes in different places depending on the error type; a real
// JSON-RPC node returns them as `error.data` (hex). Normalise so viem can decode custom errors
// through the proxy exactly as it would against mainnet.
let loggedErrorShape = false;
function extractRevertData(err: any): string | undefined {
  const candidates = [err?.data?.data, err?.data, err?.cause?.data?.data, err?.cause?.data, err?.error?.data];
  for (const c of candidates) if (typeof c === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(c)) return c;
  const text = [err?.message, err?.details, err?.cause?.message, err?.data?.message].filter(Boolean).join(' ');
  const m = text.match(/0x[0-9a-fA-F]{8,}/);
  return m ? m[0] : undefined;
}

async function startRpcProxy(provider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const handleOne = async (item: any) => {
          try {
            return { jsonrpc: '2.0', id: item.id, result: await provider.request({ method: item.method, params: item.params }) };
          } catch (err: any) {
            if (!loggedErrorShape) {
              loggedErrorShape = true;
              console.log(`  [proxy] first provider error shape: keys=${JSON.stringify(Object.keys(err || {}))} data=${JSON.stringify(err?.data)} message=${JSON.stringify(err?.message).slice(0, 200)}`);
            }
            const data = extractRevertData(err);
            return { jsonrpc: '2.0', id: item.id, error: { code: data ? 3 : (err?.code ?? -32000), message: err?.shortMessage || err?.message || String(err), data } };
          }
        };
        const out = Array.isArray(payload) ? await Promise.all(payload.map(handleOne)) : await handleOne(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

// Last definition wins, exactly like the scripts' own .env.local loaders (a key defined twice in
// the file resolves to its later value there too).
function readEnvLocal(key: string): string | undefined {
  if (!fs.existsSync('.env.local')) return undefined;
  let value: string | undefined;
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) value = m[2].replace(/^['"]|['"]$/g, '');
  }
  return value;
}

describe('Wallet-signed loss-reward claim (real pool on mainnet fork, real frontend module, exact balance deltas)', () => {
  it('claims from the holder wallet: batch, single, double-claim guard, wrong-account guard, and the real holder if still unclaimed', async () => {
    const { viem, networkHelpers, provider } = await network.create('robinhoodFork');
    const publicClient = await viem.getPublicClient();
    const [, , claimantWallet, strangerWallet] = await viem.getWalletClients();
    const CLAIMANT = getAddress(claimantWallet.account.address);
    const STRANGER = getAddress(strangerWallet.account.address);
    await networkHelpers.setBalance(CLAIMANT, parseEther('1'));
    await networkHelpers.setBalance(STRANGER, parseEther('1'));
    // EDR refuses to execute a call at exactly the fork block on this chain — mine one first.
    await networkHelpers.mine(1);

    console.log('--- Fork setup ---');
    console.log('Forked at block:', await publicClient.getBlockNumber());
    const code = await publicClient.getCode({ address: POOL });
    assert.ok(code && code !== '0x', 'real LossRewardPool must have code on the fork');

    const rpcProxy = await startRpcProxy(provider);
    console.log('Local RPC proxy (same fork state):', rpcProxy.url);

    let vite: Awaited<ReturnType<typeof createViteServer>> | null = null;
    try {
      // The frontend resolves its RPC from import.meta.env.VITE_EVM_RPC_URL at module load; point
      // it at the fork BEFORE Vite starts, then PROVE it took effect — otherwise the "real function"
      // would be quietly hitting mainnet.
      process.env.VITE_EVM_RPC_URL = rpcProxy.url;
      vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
      const evmNetwork = await vite.ssrLoadModule('/src/lib/evmNetwork.ts');
      assert.equal(evmNetwork.EVM_RPC_URL, rpcProxy.url, 'frontend module must be wired to the fork proxy, not mainnet');
      const lossReward = await vite.ssrLoadModule('/src/lib/lossReward.ts');
      assert.equal(typeof lossReward.claimBatchRewards, 'function');
      console.log('Real src/lib/lossReward.ts loaded via Vite SSR; EVM_RPC_URL =', evmNetwork.EVM_RPC_URL);

      // Minimal EIP-1193 wallet: answers accounts/chain-switch itself, forwards everything else
      // (eth_sendTransaction, eth_getTransactionReceipt, eth_chainId, ...) to the fork.
      let activeAccount: `0x${string}` = CLAIMANT;
      const sent: string[] = [];
      (globalThis as any).window = {
        ethereum: {
          request: async ({ method, params }: { method: string; params?: unknown[] }) => {
            if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [activeAccount];
            if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
            const result = await provider.request({ method, params });
            if (method === 'eth_sendTransaction') sent.push(result as string);
            return result;
          },
        },
      };

      const pool = await viem.getContractAt('LossRewardPool', POOL);
      await networkHelpers.impersonateAccount(OWNER);
      await networkHelpers.setBalance(OWNER, parseEther('1'));
      const ownerWallet = await viem.getWalletClient(OWNER);
      assert.equal(getAddress(await pool.read.owner()), OWNER, 'impersonated account must be the real pool owner');

      const claimVia = async (wallet: `0x${string}`, epochs: any[]) => {
        const before = await publicClient.getBalance({ address: wallet });
        const sentBefore = sent.length;
        const res = await lossReward.claimBatchRewards(TESTINGG, wallet, epochs);
        const after = await publicClient.getBalance({ address: wallet });
        let fee = 0n;
        let tx: any = null;
        let receipt: any = null;
        if (res.txHash) {
          receipt = await publicClient.getTransactionReceipt({ hash: res.txHash });
          tx = await publicClient.getTransaction({ hash: res.txHash });
          fee = receipt.gasUsed * receipt.effectiveGasPrice;
        }
        return { res, netDelta: after - before + fee, tx, receipt, txsSent: sent.length - sentBefore };
      };

      // ================================================================================
      // SCENARIO B — synthetic epochs published by the real owner, claimed by a fresh wallet.
      // ================================================================================
      console.log('\n=== SCENARIO B: owner publishes synthetic epochs; fresh wallet claims via the real function ===');
      const unallocated = await pool.read.getUnallocatedBalance([TESTINGG]);
      const synth = [
        { epochNumber: 900001, amountWei: 1_000_000_000_000_000n },
        { epochNumber: 900002, amountWei: 700_000_000_000_000n },
        { epochNumber: 900003, amountWei: 300_000_000_000_000n },
      ];
      const synthTotal = synth.reduce((s, e) => s + e.amountWei, 0n);
      console.log(`Pool unallocated for TESTINGG: ${formatEther(unallocated)} ETH; publishing ${formatEther(synthTotal)} ETH across 3 synthetic epochs`);
      assert.ok(unallocated >= synthTotal, 'real pool must have enough unallocated ETH to fund the synthetic epochs');
      for (const e of synth) {
        const root = leafFor(TESTINGG, BigInt(e.epochNumber), CLAIMANT, e.amountWei);
        await publicClient.waitForTransactionReceipt({
          hash: await pool.write.setEpochMerkleRoot([TESTINGG, BigInt(e.epochNumber), root, e.amountWei], { account: ownerWallet.account }),
        });
        assert.equal(await pool.read.epochMerkleRoots([TESTINGG, BigInt(e.epochNumber)]), root, `epoch #${e.epochNumber} root must be on-chain`);
      }
      const asUnclaimed = (e: { epochNumber: number; amountWei: bigint }) => ({
        id: e.epochNumber, epochId: e.epochNumber, epochNumber: e.epochNumber,
        finalRewardEth: Number(e.amountWei) / 1e18, amountWei: e.amountWei.toString(), merkleProof: [],
      });

      // B1: batch of two -> claimBatch path
      console.log('\n[B1] batch claim of epochs 900001 + 900002');
      const b1 = await claimVia(CLAIMANT, [asUnclaimed(synth[1]), asUnclaimed(synth[0])]); // deliberately unsorted
      assert.equal(b1.res.success, true);
      assert.ok(b1.res.txHash, 'a real tx hash must be returned');
      assert.equal(b1.receipt.status, 'success');
      assert.equal(getAddress(b1.tx.from), CLAIMANT, 'tx MUST be sent by the holder wallet — not the operator');
      assert.notEqual(getAddress(b1.tx.from), OWNER, 'tx must NOT come from the operator/owner wallet');
      assert.equal(getAddress(b1.tx.to), POOL);
      assert.equal(b1.netDelta, synth[0].amountWei + synth[1].amountWei, 'balance must rise by EXACTLY the two rewards, net of gas');
      assert.equal(b1.res.claimedEth, formatEther(synth[0].amountWei + synth[1].amountWei));
      assert.equal(await pool.read.hasClaimed([TESTINGG, 900001n, CLAIMANT]), true);
      assert.equal(await pool.read.hasClaimed([TESTINGG, 900002n, CLAIMANT]), true);
      console.log(`  tx ${b1.res.txHash} from=${b1.tx.from} gasUsed=${b1.receipt.gasUsed} | net delta ${formatEther(b1.netDelta)} ETH == ${formatEther(synth[0].amountWei + synth[1].amountWei)} ETH  PASS`);

      // B2: single -> claimReward path
      console.log('\n[B2] single claim of epoch 900003');
      const b2 = await claimVia(CLAIMANT, [asUnclaimed(synth[2])]);
      assert.equal(b2.receipt.status, 'success');
      assert.equal(getAddress(b2.tx.from), CLAIMANT);
      assert.equal(b2.netDelta, synth[2].amountWei, 'single claim must pay exactly its amount net of gas');
      assert.equal(await pool.read.hasClaimed([TESTINGG, 900003n, CLAIMANT]), true);
      console.log(`  tx ${b2.res.txHash} | net delta ${formatEther(b2.netDelta)} ETH == ${formatEther(synth[2].amountWei)} ETH  PASS`);

      // B3: double-claim -> must short-circuit as alreadyClaimed, sending NO transaction
      console.log('\n[B3] double-claim of epoch 900001 (must not send a tx)');
      const b3 = await claimVia(CLAIMANT, [asUnclaimed(synth[0])]);
      assert.equal(b3.res.alreadyClaimed, true, 'pre-flight must decode AlreadyClaimed and return alreadyClaimed');
      assert.equal(b3.res.txHash, null);
      assert.equal(b3.txsSent, 0, 'no eth_sendTransaction may be issued for an already-claimed epoch');
      assert.equal(b3.netDelta, 0n);
      console.log('  short-circuited as alreadyClaimed, 0 transactions sent  PASS');

      // B4: wrong active account -> must refuse before any tx
      console.log('\n[B4] wallet active account != holder (must refuse before sending)');
      const rootStranger = leafFor(TESTINGG, 900004n, CLAIMANT, 100_000_000_000_000n);
      await publicClient.waitForTransactionReceipt({ hash: await pool.write.setEpochMerkleRoot([TESTINGG, 900004n, rootStranger, 100_000_000_000_000n], { account: ownerWallet.account }) });
      activeAccount = STRANGER;
      const sentBeforeB4 = sent.length;
      await assert.rejects(
        lossReward.claimBatchRewards(TESTINGG, CLAIMANT, [asUnclaimed({ epochNumber: 900004, amountWei: 100_000_000_000_000n })]),
        /not the holder these rewards belong to/,
        'must refuse when the connected account is not the holder'
      );
      assert.equal(sent.length - sentBeforeB4, 0, 'no transaction may be sent from the wrong account');
      assert.equal(await pool.read.hasClaimed([TESTINGG, 900004n, CLAIMANT]), false);
      activeAccount = CLAIMANT;
      console.log('  refused with a clear error, 0 transactions sent  PASS');

      // ================================================================================
      // SCENARIO A — the REAL holder claims its REAL published TESTINGG epochs (if unclaimed).
      // ================================================================================
      console.log('\n=== SCENARIO A: real holder, real published epochs (read-only DB read, claim on fork) ===');
      const sbUrl = readEnvLocal('VITE_SUPABASE_URL') || readEnvLocal('SUPABASE_URL');
      const sbKey = readEnvLocal('SUPABASE_SERVICE_ROLE_KEY');
      if (!sbUrl || !sbKey) {
        console.log('  SKIPPED: no Supabase credentials in .env.local to read the real proofs.');
      } else {
        const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } });
        const { data: rows, error } = await sb
          .from('epoch_holder_rewards')
          .select('id, epoch_id, final_reward_eth, merkle_proof, reward_epochs!inner(epoch_number, status)')
          .eq('token_address', TESTINGG.toLowerCase())
          .eq('wallet_address', HOLDER.toLowerCase())
          .eq('claimed', false);
        assert.equal(error, null, `DB read failed: ${error?.message}`);
        const real: any[] = [];
        for (const r of rows || []) {
          if ((r as any).reward_epochs?.status !== 'published') continue;
          const epochNumber = Number((r as any).reward_epochs.epoch_number);
          const amountWei = BigInt(Math.round(Number(r.final_reward_eth) * 1e18));
          const root = await pool.read.epochMerkleRoots([TESTINGG, BigInt(epochNumber)]);
          const claimed = await pool.read.hasClaimed([TESTINGG, BigInt(epochNumber), HOLDER]);
          if (/^0x0+$/.test(root) || claimed) continue;
          real.push({ id: r.id, epochId: r.epoch_id, epochNumber, finalRewardEth: Number(r.final_reward_eth), amountWei: amountWei.toString(), merkleProof: Array.isArray(r.merkle_proof) ? r.merkle_proof : [] });
        }
        if (real.length === 0) {
          console.log('  SKIPPED: the real holder has no unclaimed published epochs at the fork block (already claimed on mainnet).');
        } else {
          const realTotal = real.reduce((s, e) => s + BigInt(e.amountWei), 0n);
          console.log(`  ${real.length} real unclaimed epoch(s) [${real.map((e) => e.epochNumber).join(', ')}], total ${formatEther(realTotal)} ETH`);
          await networkHelpers.impersonateAccount(HOLDER);
          await networkHelpers.setBalance(HOLDER, parseEther('1')); // gas only; the reward is paid by the pool
          activeAccount = HOLDER;
          const a = await claimVia(HOLDER, real);
          assert.equal(a.receipt.status, 'success');
          assert.equal(getAddress(a.tx.from), HOLDER, 'the real holder must be msg.sender');
          assert.equal(a.netDelta, realTotal, 'real holder balance must rise by EXACTLY the sum of its published rewards, net of gas');
          for (const e of real) assert.equal(await pool.read.hasClaimed([TESTINGG, BigInt(e.epochNumber), HOLDER]), true, `epoch #${e.epochNumber} must be marked claimed`);
          console.log(`  tx ${a.res.txHash} from=${a.tx.from} gasUsed=${a.receipt.gasUsed} | net delta ${formatEther(a.netDelta)} ETH == ${formatEther(realTotal)} ETH  PASS`);
        }
      }

      console.log('\n=== RESULT: wallet-signed claims verified against the real pool with exact balance deltas ===');
    } finally {
      if (vite) await vite.close();
      rpcProxy.server.close();
      rpcProxy.server.closeAllConnections?.();
      delete (globalThis as any).window;
    }
  });
});
