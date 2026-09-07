/**
 * Claim loss-reward epochs DIRECTLY from the holder's own wallet (no relayer).
 *
 * Why this exists: the gateway's gasless /claim relays claimBatch from the OPERATOR wallet, but
 * LossRewardPool binds the Merkle leaf (and the payout) to msg.sender — so a relayed claim
 * reverts InvalidProof (0x09bde339) for every wallet except the operator itself. Until the UI
 * signs claims from the connected wallet, this script does exactly that, safely.
 *
 * Safety pattern (same as tonight's deploy scripts):
 *   - CLAIMER_PRIVATE_KEY is read from the environment of YOUR shell only; it is never printed.
 *   - DRY RUN by default: fetches your unclaimed epochs, verifies each proof locally against the
 *     on-chain root, and SIMULATES the exact claimBatch. Nothing is broadcast.
 *   - Broadcast only with CLAIM_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET.
 *   - After broadcast: waits for the receipt and checks your balance rose by EXACTLY the claimed
 *     total net of gas, and that hasClaimed() flipped for every epoch.
 *   - Keyless preview: `--preview 0xYourAddress` runs the read-only part for any address.
 *
 * Usage (PowerShell):
 *   $env:CLAIMER_PRIVATE_KEY = "0x<your key>"
 *   node scripts/claim-loss-rewards.mjs 0x7F9b8A09877F6e8096b0b8c6027DC49580b05474            # dry run
 *   $env:CLAIM_CONFIRM = "I_UNDERSTAND_THIS_IS_MAINNET"
 *   node scripts/claim-loss-rewards.mjs 0x7F9b8A09877F6e8096b0b8c6027DC49580b05474            # real claim
 *   Remove-Item Env:CLAIMER_PRIVATE_KEY; Remove-Item Env:CLAIM_CONFIRM
 * Optional: --epochs 26,27 to restrict which epochs to claim.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import {
  createPublicClient, createWalletClient, http, defineChain, getAddress, parseAbi, formatEther, formatGwei,
  keccak256, encodeAbiParameters, parseAbiParameters, concat, hexToBigInt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ---- config ---------------------------------------------------------------------------------
const env = {};
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
const RPC_URL = process.env.VITE_EVM_RPC_URL || env.VITE_EVM_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const POOL = getAddress(process.env.VITE_LOSS_REWARD_POOL || env.VITE_LOSS_REWARD_POOL || '0x697BDA9db5a297a9Cd9ED969BBF2549d0527DcdF');
const SUPABASE_URL = env.VITE_SUPABASE_URL || env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const CONFIRM = process.env.CLAIM_CONFIRM === 'I_UNDERSTAND_THIS_IS_MAINNET';

const args = process.argv.slice(2);
const tokenArg = args.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
const previewIdx = args.indexOf('--preview');
const previewAddr = previewIdx !== -1 ? args[previewIdx + 1] : null;
const epochsIdx = args.indexOf('--epochs');
const onlyEpochs = epochsIdx !== -1 ? new Set(args[epochsIdx + 1].split(',').map((s) => Number(s.trim()))) : null;
if (!tokenArg) {
  console.error('Usage: node scripts/claim-loss-rewards.mjs <tokenAddress> [--epochs 26,27] [--preview 0xAddress]');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing Supabase credentials (.env.local: VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) - needed to read your unclaimed epochs/proofs.');
  process.exit(1);
}
const TOKEN = getAddress(tokenArg);

const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const publicClient = createPublicClient({ chain: robinhood, transport: http(RPC_URL, { timeout: 30_000, retryCount: 3, retryDelay: 1500 }) });

// Full ABI INCLUDING the custom errors, so any revert decodes to a name instead of a bare selector.
const POOL_ABI = parseAbi([
  'function claimReward(address token, uint256 epochId, uint256 amount, bytes32[] merkleProof)',
  'function claimBatch(address token, uint256[] epochIds, uint256[] amounts, bytes32[][] merkleProofs)',
  'function epochMerkleRoots(address token, uint256 epochId) view returns (bytes32)',
  'function hasClaimed(address token, uint256 epochId, address claimant) view returns (bool)',
  'error Unauthorized()',
  'error ZeroAddress()',
  'error ZeroAmount()',
  'error EpochAlreadyPublished()',
  'error InsufficientUnallocatedPool()',
  'error InvalidMerkleRoot()',
  'error EpochNotPublished()',
  'error AlreadyClaimed()',
  'error InvalidProof()',
  'error EthTransferFailed()',
  'error ArrayLengthMismatch()',
  'error ReentrancyGuardReentrantCall()',
]);

// ---- who is claiming ------------------------------------------------------------------------
let account = null;
let claimer;
if (previewAddr) {
  claimer = getAddress(previewAddr);
  console.log(`PREVIEW MODE (read-only, no key) for ${claimer}`);
} else {
  const pk = process.env.CLAIMER_PRIVATE_KEY;
  if (!pk) {
    console.error('CLAIMER_PRIVATE_KEY is not set in this shell (or use --preview 0xAddress for a keyless dry run).');
    process.exit(1);
  }
  account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
  claimer = account.address;
  console.log(`Claimer wallet (derived from CLAIMER_PRIVATE_KEY; the key itself is never printed): ${claimer}`);
}
const mode = previewAddr ? 'preview' : CONFIRM ? '*** BROADCAST (mainnet) ***' : 'DRY RUN (set CLAIM_CONFIRM=I_UNDERSTAND_THIS_IS_MAINNET to broadcast)';
console.log(`Token: ${TOKEN}\nPool:  ${POOL}\nRPC:   ${RPC_URL}\nMode:  ${mode}\n`);

// ---- fetch unclaimed published epochs for (token, claimer) -----------------------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const { data: rows, error } = await supabase
  .from('epoch_holder_rewards')
  .select('id, epoch_id, final_reward_eth, merkle_proof, claimed, reward_epochs!inner(epoch_number, status, merkle_root)')
  .eq('token_address', TOKEN.toLowerCase())
  .eq('wallet_address', claimer.toLowerCase())
  .eq('claimed', false);
if (error) {
  console.error(`DB error: ${error.code} ${error.message}`);
  process.exit(1);
}

// Leaf exactly as LossRewardPool._claimEpoch computes it: keccak256(bytes.concat(keccak256(abi.encode(token, epochId, claimant, amount))))
const leafFor = (epochNumber, amountWei) =>
  keccak256(keccak256(encodeAbiParameters(parseAbiParameters('address,uint256,address,uint256'), [TOKEN, BigInt(epochNumber), claimer, amountWei])));
// OpenZeppelin MerkleProof: sorted-pair hashing up the tree; an empty proof means leaf == root.
const verifyProof = (leaf, proof, root) => {
  let h = leaf;
  for (const p of proof) h = hexToBigInt(h) < hexToBigInt(p) ? keccak256(concat([h, p])) : keccak256(concat([p, h]));
  return h === root;
};

const candidates = [];
for (const r of rows || []) {
  const epochNumber = Number(r.reward_epochs?.epoch_number ?? r.epoch_id);
  if (onlyEpochs && !onlyEpochs.has(epochNumber)) continue;
  if (r.reward_epochs?.status !== 'published') {
    console.log(`  skip epoch #${epochNumber}: status=${r.reward_epochs?.status} (not published)`);
    continue;
  }
  const amountWei = BigInt(Math.round(Number(r.final_reward_eth) * 1e18)); // same rounding the worker/gateway use
  const proof = Array.isArray(r.merkle_proof) ? r.merkle_proof : [];
  const [rootChain, claimed] = await Promise.all([
    publicClient.readContract({ address: POOL, abi: POOL_ABI, functionName: 'epochMerkleRoots', args: [TOKEN, BigInt(epochNumber)] }),
    publicClient.readContract({ address: POOL, abi: POOL_ABI, functionName: 'hasClaimed', args: [TOKEN, BigInt(epochNumber), claimer] }),
  ]);
  const unset = /^0x0+$/.test(rootChain);
  const ok = !unset && !claimed && verifyProof(leafFor(epochNumber, amountWei), proof, rootChain);
  console.log(
    `  epoch #${epochNumber}: ${formatEther(amountWei)} ETH (${amountWei} wei) proof_len=${proof.length} root_on_chain=${unset ? 'UNSET' : rootChain.slice(0, 10) + '...'} hasClaimed=${claimed} local_proof_check=${ok ? 'VALID' : 'INVALID/SKIP'}`
  );
  if (ok) candidates.push({ epochNumber, amountWei, proof });
}
if (candidates.length === 0) {
  console.log('\nNothing claimable for this wallet on this token.');
  process.exit(0);
}
candidates.sort((a, b) => a.epochNumber - b.epochNumber);
const total = candidates.reduce((s, c) => s + c.amountWei, 0n);
const callArgs = [TOKEN, candidates.map((c) => BigInt(c.epochNumber)), candidates.map((c) => c.amountWei), candidates.map((c) => c.proof)];
console.log(`\nclaimBatch(${TOKEN}, [${callArgs[1].join(',')}], [${callArgs[2].join(',')}], [${callArgs[3].map((p) => '[' + p.join(',') + ']').join(',')}])`);
console.log(`Total to claim: ${formatEther(total)} ETH (${total} wei) across ${candidates.length} epoch(s)`);

// ---- simulate (exactly what will be sent, as the claimer) -----------------------------------
try {
  await publicClient.simulateContract({ address: POOL, abi: POOL_ABI, functionName: 'claimBatch', args: callArgs, account: claimer });
  const gas = await publicClient.estimateContractGas({ address: POOL, abi: POOL_ABI, functionName: 'claimBatch', args: callArgs, account: claimer });
  const gasPrice = await publicClient.getGasPrice();
  const fee = gas * gasPrice;
  console.log(`Simulation: OK. Estimated gas ${gas} @ ${formatGwei(gasPrice)} gwei = ${formatEther(fee)} ETH fee (reward is ${(Number(total) / Number(fee)).toFixed(1)}x the fee)`);
} catch (e) {
  console.error(`Simulation FAILED - not broadcasting. Decoded: ${e.shortMessage || e.message}`);
  process.exit(1);
}

if (previewAddr || !CONFIRM) {
  console.log('\nDRY RUN complete - nothing was broadcast.');
  process.exit(0);
}

// ---- broadcast ------------------------------------------------------------------------------
const walletClient = createWalletClient({ account, chain: robinhood, transport: http(RPC_URL, { timeout: 30_000, retryCount: 3, retryDelay: 1500 }) });
const balBefore = await publicClient.getBalance({ address: claimer });
console.log(`\nBroadcasting claimBatch from ${claimer} ...`);
const hash = await walletClient.writeContract({ address: POOL, abi: POOL_ABI, functionName: 'claimBatch', args: callArgs });
console.log(`tx hash: ${hash}\nWaiting for receipt...`);
const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
const fee = receipt.gasUsed * receipt.effectiveGasPrice;
const balAfter = await publicClient.getBalance({ address: claimer });
const netDelta = balAfter - balBefore + fee;
console.log(`status=${receipt.status} block=${receipt.blockNumber} gasUsed=${receipt.gasUsed} fee=${formatEther(fee)} ETH`);
console.log(`balance delta net of gas = ${formatEther(netDelta)} ETH -> ${netDelta === total ? 'EXACTLY the claimed total (OK)' : 'MISMATCH (expected ' + formatEther(total) + ')'}`);
for (const c of candidates) {
  const claimed = await publicClient.readContract({ address: POOL, abi: POOL_ABI, functionName: 'hasClaimed', args: [TOKEN, BigInt(c.epochNumber), claimer] });
  console.log(`  hasClaimed(epoch #${c.epochNumber}) = ${claimed}${claimed ? ' (OK)' : ' (NOT SET?)'}`);
}
console.log('\nNote: the site marks these rows claimed automatically the next time the token page loads (the gateway reconciles against hasClaimed on-chain).');
if (receipt.status !== 'success') process.exit(1);
