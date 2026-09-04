import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import {
  isAddress,
  getAddress,
  verifyMessage,
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
  formatEther,
} from 'npm:viem@2.55.2';
import { privateKeyToAccount } from 'npm:viem@2.55.2/accounts';

// ----------------------------------------------------------------------------
// CORS & Configuration
// ----------------------------------------------------------------------------
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

// SESSION_SECRET signs the HS256 JWTs that authenticate wallet sessions for
// loss-reward claim access. There is deliberately NO hardcoded fallback here:
// a default secret checked into source would let anyone forge a valid session
// for any wallet address. Fail fast at cold start instead of silently running
// with a public, guessable key.
const SESSION_SECRET = Deno.env.get('SESSION_SECRET');
if (!SESSION_SECRET) {
  throw new Error(
    'SESSION_SECRET environment variable is required and must not be empty. ' +
      'Refusing to start with an insecure default — set a strong, unique secret ' +
      'in the Edge Function environment before deploying.'
  );
}

const RPC_URL = Deno.env.get('RPC_URL') || Deno.env.get('VITE_EVM_RPC_URL') || Deno.env.get('EVM_RPC_URL') || 'https://rpc.mainnet.chain.robinhood.com';
const LOSS_REWARD_POOL_ADDRESS = Deno.env.get('LOSS_REWARD_POOL_ADDRESS') || Deno.env.get('VITE_LOSS_REWARD_POOL') || '0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf';
const OPERATOR_PRIVATE_KEY = Deno.env.get('OPERATOR_PRIVATE_KEY') || '';

const POOL_ABI = parseAbi([
  'function hasClaimed(address token, uint256 epochId, address account) view returns (bool)',
  'function claimReward(address token, uint256 epochId, uint256 amount, bytes32[] calldata merkleProof)',
  'function claimBatch(address token, uint256[] calldata epochIds, uint256[] calldata amounts, bytes32[][] calldata merkleProofs)',
]);

const JWT_ISSUER = 'incentifi.finance';
const JWT_AUDIENCE = 'incentifi-loss-reward';
const JWT_EXPIRATION_SECONDS = 3600; // 1 hour
const NONCE_TTL_SECONDS = 300; // 5 minutes
const MAX_ACTIVE_CHALLENGES_PER_WALLET = 5;

// Service-role Supabase client (only runs inside Edge Function)
const getServiceClient = () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase service role credentials not configured in gateway environment.');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
};

// ----------------------------------------------------------------------------
// Deterministic Authentication Challenge Message
// ----------------------------------------------------------------------------
export function buildAuthMessage(
  walletAddress: string,
  nonce: string,
  issuedAt: string,
  expiresAt: string
): string {
  return [
    'Incentifi Loss-Reward Protection Authentication',
    '',
    'Domain: incentifi.finance',
    'Purpose: Authenticate wallet for private loss-reward position and claim access.',
    `Wallet Address: ${walletAddress}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`,
    '',
    'Sign this message to prove ownership of this wallet. This request will not trigger any blockchain transaction or cost any gas fees.',
  ].join('\n');
}

// ----------------------------------------------------------------------------
// Cryptographic JWT (HS256) via Web Crypto API
// ----------------------------------------------------------------------------
function base64UrlEncode(str: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

async function getCryptoKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signJwt(
  payload: Record<string, any>,
  secret = SESSION_SECRET
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const key = await getCryptoKey(secret);
  const encoder = new TextEncoder();
  const signatureBytes = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(dataToSign)
  );

  let binarySig = '';
  const bytes = new Uint8Array(signatureBytes);
  for (let i = 0; i < bytes.byteLength; i++) {
    binarySig += String.fromCharCode(bytes[i]);
  }
  const encodedSig = btoa(binarySig)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${dataToSign}.${encodedSig}`;
}

export async function verifyJwt(
  token: string,
  secret = SESSION_SECRET
): Promise<{ wallet_address: string; iss: string; aud: string; iat: number; exp: number }> {
  if (!token || typeof token !== 'string') {
    throw new Error('Missing or invalid session token format.');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed session token.');
  }

  const [headerB64, payloadB64, sigB64] = parts;

  // 1. Strictly enforce algorithm pinning to HS256
  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(base64UrlDecode(headerB64));
  } catch {
    throw new Error('Malformed token header.');
  }

  if (header.alg !== 'HS256') {
    throw new Error('Unsupported signature algorithm. Only HS256 is permitted.');
  }

  // 2. Verify Cryptographic Signature with timing-safe Web Crypto
  const key = await getCryptoKey(secret);
  const encoder = new TextEncoder();
  const dataToVerify = `${headerB64}.${payloadB64}`;

  let binarySig = '';
  let base64 = sigB64.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  try {
    binarySig = atob(base64);
  } catch {
    throw new Error('Invalid signature encoding in session token.');
  }
  const sigBytes = new Uint8Array(binarySig.length);
  for (let i = 0; i < binarySig.length; i++) {
    sigBytes[i] = binarySig.charCodeAt(i);
  }

  const isValid = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes,
    encoder.encode(dataToVerify)
  );

  if (!isValid) {
    throw new Error('Invalid session token signature.');
  }

  // 3. Parse & Validate Payload Claims
  let payload: any;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    throw new Error('Malformed token payload.');
  }

  const nowSec = Math.floor(Date.now() / 1000);

  if (payload.iss !== JWT_ISSUER) {
    throw new Error(`Invalid token issuer: expected ${JWT_ISSUER}.`);
  }
  if (payload.aud !== JWT_AUDIENCE) {
    throw new Error(`Invalid token audience: expected ${JWT_AUDIENCE}.`);
  }
  if (!payload.exp || payload.exp <= nowSec) {
    throw new Error('Session token has expired.');
  }
  if (!payload.wallet_address || !isAddress(payload.wallet_address)) {
    throw new Error('Session token contains invalid wallet address.');
  }

  return {
    wallet_address: getAddress(payload.wallet_address).toLowerCase(),
    iss: payload.iss,
    aud: payload.aud,
    iat: payload.iat,
    exp: payload.exp,
  };
}

// ----------------------------------------------------------------------------
// Request Handlers
// ----------------------------------------------------------------------------

/**
 * Endpoint 1: POST /challenge
 * Generates an authentication nonce with a 5-minute TTL.
 */
export async function handleChallenge(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { walletAddress } = body || {};
  if (!walletAddress || !isAddress(walletAddress)) {
    return new Response(JSON.stringify({ error: 'Valid EVM walletAddress is required.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const normalizedWallet = getAddress(walletAddress).toLowerCase();
  const supabase = getServiceClient();

  // Rate Limiting: Check active unused challenges for this wallet
  const now = new Date();
  const { data: activeChallenges, error: countErr } = await supabase
    .from('auth_nonces')
    .select('id')
    .eq('wallet_address', normalizedWallet)
    .eq('used', false)
    .gt('expires_at', now.toISOString());

  if (!countErr && activeChallenges && activeChallenges.length >= MAX_ACTIVE_CHALLENGES_PER_WALLET) {
    return new Response(
      JSON.stringify({
        error: 'Too many active authentication challenges for this wallet. Please wait for previous challenges to expire.',
      }),
      { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const nonce = crypto.randomUUID();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + NONCE_TTL_SECONDS * 1000).toISOString();

  const { error: insertErr } = await supabase.from('auth_nonces').insert({
    wallet_address: normalizedWallet,
    nonce,
    issued_at: issuedAt,
    expires_at: expiresAt,
    used: false,
  });

  if (insertErr) {
    console.error('Failed to create auth nonce:', insertErr);
    return new Response(JSON.stringify({ error: 'Failed to record authentication challenge.' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const message = buildAuthMessage(getAddress(walletAddress), nonce, issuedAt, expiresAt);

  return new Response(
    JSON.stringify({
      nonce,
      issuedAt,
      expiresAt,
      message,
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

/**
 * Endpoint 2: POST /verify
 * Verifies EIP-191 personal_sign signature, atomically burns the nonce, and issues a 1-hour session JWT.
 */
export async function handleVerify(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { walletAddress, nonce, signature } = body || {};
  if (!walletAddress || !isAddress(walletAddress) || !nonce || !signature) {
    return new Response(
      JSON.stringify({ error: 'walletAddress, nonce, and signature are required.' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const normalizedWallet = getAddress(walletAddress).toLowerCase();
  const supabase = getServiceClient();

  // Step A: Retrieve server-side nonce record (Read-Only)
  const { data: nonceRecord, error: fetchErr } = await supabase
    .from('auth_nonces')
    .select('*')
    .eq('nonce', nonce)
    .eq('wallet_address', normalizedWallet)
    .maybeSingle();

  if (fetchErr || !nonceRecord) {
    return new Response(
      JSON.stringify({ error: 'Authentication challenge not found or invalid wallet address.' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Step B: Confirm unused and not expired
  if (nonceRecord.used) {
    return new Response(
      JSON.stringify({ error: 'Authentication challenge has already been used.' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  if (new Date(nonceRecord.expires_at).getTime() <= Date.now()) {
    return new Response(
      JSON.stringify({ error: 'Authentication challenge has expired. Request a new challenge.' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Step C: Reconstruct exact message exclusively from server-side record
  const expectedMessage = buildAuthMessage(
    getAddress(nonceRecord.wallet_address),
    nonceRecord.nonce,
    new Date(nonceRecord.issued_at).toISOString(),
    new Date(nonceRecord.expires_at).toISOString()
  );

  // Step D: Cryptographically verify EIP-191 personal_sign signature via viem
  let isSignatureValid = false;
  try {
    isSignatureValid = await verifyMessage({
      address: getAddress(normalizedWallet),
      message: expectedMessage,
      signature: signature as `0x${string}`,
    });
  } catch (err) {
    console.warn('Signature verification exception:', err);
    isSignatureValid = false;
  }

  if (!isSignatureValid) {
    // Nonce is NOT burned on invalid signature, preserving valid challenges
    return new Response(
      JSON.stringify({ error: 'Cryptographic signature verification failed.' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Step E & F: Atomically consume nonce in database
  const { data: consumedNonce, error: consumeErr } = await supabase.rpc('consume_auth_nonce', {
    p_nonce: nonce,
    p_wallet_address: normalizedWallet,
  });

  if (consumeErr || !consumedNonce || consumedNonce.length === 0) {
    return new Response(
      JSON.stringify({ error: 'Authentication challenge was consumed by a concurrent request.' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Step G: Mint short-lived Session JWT (1-hour expiration)
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + JWT_EXPIRATION_SECONDS;

  const sessionToken = await signJwt({
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    wallet_address: normalizedWallet,
    iat: nowSec,
    exp: expSec,
  });

  return new Response(
    JSON.stringify({
      sessionToken,
      walletAddress: getAddress(normalizedWallet),
      expiresAt: expSec,
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

/**
 * Endpoint 3: POST /query
 * Serves private Loss-Reward data exclusively for the wallet in the verified session token.
 */
export async function handleQuery(req: Request): Promise<Response> {
  const authHeader = req.headers.get('Authorization') || req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(
      JSON.stringify({ error: 'Authorization header with Bearer token is required.' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const token = authHeader.slice(7).trim();
  let claims: { wallet_address: string };

  try {
    claims = await verifyJwt(token);
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || 'Invalid or expired session token.' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { tokenAddress } = body || {};
  if (!tokenAddress || !isAddress(tokenAddress)) {
    return new Response(JSON.stringify({ error: 'Valid EVM tokenAddress is required.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // The caller's wallet identity is derived SOLELY from the verified JWT
  const callerWallet = claims.wallet_address.toLowerCase();
  const normalizedToken = getAddress(tokenAddress).toLowerCase();
  const supabase = getServiceClient();

  try {
    const [costBasisRes, claimableRes] = await Promise.all([
      supabase
        .from('holder_cost_basis')
        .select('token_address, wallet_address, token_balance, total_invested_eth, avg_cost_basis_eth, is_eligible, is_underwater_seller')
        .eq('token_address', normalizedToken)
        .eq('wallet_address', callerWallet)
        .maybeSingle(),
      supabase
        .from('epoch_holder_rewards')
        .select(`
          id,
          epoch_id,
          final_reward_eth,
          merkle_proof,
          claimed,
          reward_epochs!inner (
            epoch_number,
            status
          )
        `)
        .eq('token_address', normalizedToken)
        .eq('wallet_address', callerWallet)
        .eq('claimed', false),
    ]);

    const costBasisData = costBasisRes.data;
    const costBasis = costBasisData
      ? {
          tokenAddress: costBasisData.token_address,
          walletAddress: costBasisData.wallet_address,
          tokenBalance: Number(costBasisData.token_balance || 0),
          totalInvestedEth: Number(costBasisData.total_invested_eth || 0),
          avgCostBasisEth: Number(costBasisData.avg_cost_basis_eth || 0),
          isEligible: costBasisData.is_eligible ?? true,
          isUnderwaterSeller: costBasisData.is_underwater_seller ?? false,
        }
      : {
          tokenAddress: normalizedToken,
          walletAddress: callerWallet,
          tokenBalance: 0,
          totalInvestedEth: 0,
          avgCostBasisEth: 0,
          isEligible: true,
          isUnderwaterSeller: false,
        };

    const candidateRows = claimableRes.data || [];
    const unclaimedEpochs: any[] = [];
    const pendingEpochs: any[] = [];
    const staleIds: number[] = [];

    if (candidateRows.length > 0) {
      const publicClient = createPublicClient({ transport: http(RPC_URL) });

      for (const d of candidateRows) {
        const epochNumber = Number(d.reward_epochs?.epoch_number || d.epoch_id);
        const epochStatus = d.reward_epochs?.status || 'published';
        const rawRewardEthStr = String(d.final_reward_eth || '0');
        let amountWei = '0';
        try {
          amountWei = BigInt(Math.round(Number(d.final_reward_eth || 0) * 1e18)).toString();
        } catch {
          amountWei = '0';
        }

        if (epochStatus === 'pending_funding') {
          // Epoch reward preserved exactly; awaiting on-chain pool funding
          pendingEpochs.push({
            id: d.id,
            epochId: Number(d.epoch_id),
            epochNumber,
            finalRewardEth: Number(d.final_reward_eth || 0),
            amountWei,
            merkleProof: Array.isArray(d.merkle_proof) ? d.merkle_proof : [],
          });
        } else {
          // Published epoch: verify on-chain hasClaimed status
          let onchainClaimed = false;

          try {
            onchainClaimed = await publicClient.readContract({
              address: getAddress(LOSS_REWARD_POOL_ADDRESS),
              abi: POOL_ABI,
              functionName: 'hasClaimed',
              args: [getAddress(normalizedToken), BigInt(epochNumber), getAddress(callerWallet)],
            });
          } catch (err: any) {
            console.error(`RPC read error for epoch ${epochNumber} in query:`, err);
            return new Response(
              JSON.stringify({ error: `Failed to verify on-chain status for epoch ${epochNumber} via RPC. Please retry shortly.` }),
              { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
          }

          if (onchainClaimed) {
            staleIds.push(d.id);
          } else {
            unclaimedEpochs.push({
              id: d.id,
              epochId: Number(d.epoch_id),
              epochNumber,
              finalRewardEth: Number(d.final_reward_eth || 0),
              amountWei,
              merkleProof: Array.isArray(d.merkle_proof) ? d.merkle_proof : [],
            });
          }
        }
      }

      // Reconcile stale rows asynchronously in DB via service_role
      if (staleIds.length > 0) {
        await supabase
          .from('epoch_holder_rewards')
          .update({ claimed: true, claimed_at: new Date().toISOString() })
          .in('id', staleIds);
      }
    }

    const totalClaimableEth = unclaimedEpochs.reduce((sum, item) => sum + item.finalRewardEth, 0);
    const totalPendingEth = pendingEpochs.reduce((sum, item) => sum + item.finalRewardEth, 0);

    return new Response(
      JSON.stringify({
        costBasis,
        claimable: {
          unclaimedEpochs,
          totalClaimableEth,
        },
        pending: {
          pendingEpochs,
          totalPendingEth,
        },
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('Failed to query loss-reward database:', err);
    return new Response(JSON.stringify({ error: 'Database query failed.' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Endpoint 4: POST /claim
 * Gasless claim execution via server operator wallet for the authenticated claimant.
 */
export async function handleClaim(req: Request): Promise<Response> {
  const authHeader = req.headers.get('Authorization') || req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(
      JSON.stringify({ error: 'Authorization header with Bearer token is required.' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const token = authHeader.slice(7).trim();
  let claims: { wallet_address: string };

  try {
    claims = await verifyJwt(token);
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || 'Invalid or expired session token.' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { tokenAddress } = body || {};
  if (!tokenAddress || !isAddress(tokenAddress)) {
    return new Response(JSON.stringify({ error: 'Valid EVM tokenAddress is required.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const callerWallet = claims.wallet_address.toLowerCase();
  const normalizedToken = getAddress(tokenAddress).toLowerCase();
  const supabase = getServiceClient();

  // 1. Retrieve all candidate unclaimed epoch records for caller and token
  const { data: rawRows, error: fetchErr } = await supabase
    .from('epoch_holder_rewards')
    .select(`
      id,
      epoch_id,
      final_reward_eth,
      merkle_proof,
      claimed,
      reward_epochs!inner (
        epoch_number,
        status
      )
    `)
    .eq('token_address', normalizedToken)
    .eq('wallet_address', callerWallet)
    .eq('claimed', false);

  if (fetchErr) {
    console.error('Failed to fetch epoch holder rewards for claim:', fetchErr);
    return new Response(JSON.stringify({ error: 'Database query failed.' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const allUnclaimedRows = rawRows || [];
  const candidateRows = allUnclaimedRows.filter((r: any) => r.reward_epochs?.status === 'published');

  if (candidateRows.length === 0) {
    const hasPending = allUnclaimedRows.some((r: any) => r.reward_epochs?.status === 'pending_funding');
    return new Response(
      JSON.stringify({
        success: true,
        txHash: null,
        claimedEth: '0',
        alreadyClaimed: true,
        message: hasPending
          ? 'Rewards are currently awaiting reward-pool funding.'
          : 'No claimable rewards available.',
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // 2. Reconcile on-chain hasClaimed status (FAIL CLOSED ON RPC ERROR)
  let publicClient: any;
  try {
    publicClient = createPublicClient({ transport: http(RPC_URL) });
  } catch (err: any) {
    console.error('Failed to initialize EVM public client:', err);
    return new Response(
      JSON.stringify({ error: 'Failed to connect to EVM RPC. Please retry shortly.' }),
      { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const claimableRows: any[] = [];
  const staleIds: number[] = [];

  for (const row of candidateRows) {
    const epochNumber = Number(row.reward_epochs?.epoch_number || row.epoch_id);
    let onchainClaimed = false;

    try {
      onchainClaimed = await publicClient.readContract({
        address: getAddress(LOSS_REWARD_POOL_ADDRESS),
        abi: POOL_ABI,
        functionName: 'hasClaimed',
        args: [getAddress(normalizedToken), BigInt(epochNumber), getAddress(callerWallet)],
      });
    } catch (err: any) {
      console.error(`RPC error: failed to verify hasClaimed for epoch ${epochNumber}:`, err);
      // FAIL CLOSED: Do not assume unclaimed, do not submit claim batch, do not alter DB for this epoch
      return new Response(
        JSON.stringify({
          error: `Failed to verify on-chain claim status for epoch ${epochNumber} via RPC. Please retry shortly.`,
        }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (onchainClaimed) {
      staleIds.push(row.id);
    } else {
      let amountWei: bigint;
      try {
        amountWei = BigInt(Math.round(Number(row.final_reward_eth || 0) * 1e18));
      } catch {
        amountWei = 0n;
      }

      claimableRows.push({
        ...row,
        epochNumber,
        amountWei,
      });
    }
  }

  // Reconcile stale rows in DB using service_role
  if (staleIds.length > 0) {
    await supabase
      .from('epoch_holder_rewards')
      .update({ claimed: true, claimed_at: new Date().toISOString() })
      .in('id', staleIds);
  }

  if (claimableRows.length === 0) {
    return new Response(
      JSON.stringify({
        success: true,
        txHash: null,
        claimedEth: '0',
        alreadyClaimed: true,
        message: 'All rewards have already been claimed on-chain.',
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // 3. Submit transaction via operator/relayer wallet
  if (!OPERATOR_PRIVATE_KEY) {
    return new Response(
      JSON.stringify({
        error: 'Relayer operator wallet is not configured on the server.',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const formattedKey = OPERATOR_PRIVATE_KEY.startsWith('0x')
    ? (OPERATOR_PRIVATE_KEY as `0x${string}`)
    : (`0x${OPERATOR_PRIVATE_KEY}` as `0x${string}`);
  const account = privateKeyToAccount(formattedKey);
  const walletClient = createWalletClient({
    account,
    transport: http(RPC_URL),
  });

  let txHash: `0x${string}`;
  try {
    if (claimableRows.length === 1) {
      const row = claimableRows[0];
      txHash = await walletClient.writeContract({
        address: getAddress(LOSS_REWARD_POOL_ADDRESS),
        abi: POOL_ABI,
        functionName: 'claimReward',
        args: [
          getAddress(normalizedToken),
          BigInt(row.epochNumber),
          row.amountWei,
          row.merkle_proof as `0x${string}`[],
        ],
      });
    } else {
      const epochIds = claimableRows.map((r) => BigInt(r.epochNumber));
      const amounts = claimableRows.map((r) => r.amountWei);
      const proofs = claimableRows.map((r) => r.merkle_proof as `0x${string}`[]);

      txHash = await walletClient.writeContract({
        address: getAddress(LOSS_REWARD_POOL_ADDRESS),
        abi: POOL_ABI,
        functionName: 'claimBatch',
        args: [getAddress(normalizedToken), epochIds, amounts, proofs],
      });
    }

    // 4. Wait for on-chain transaction receipt confirmation
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
      throw new Error(`Transaction reverted on-chain (status: ${receipt.status})`);
    }
  } catch (err: any) {
    console.error('Relayer claim execution failed:', err);

    if (err.message?.includes('AlreadyClaimed')) {
      const claimableIds = claimableRows.map((r) => r.id);
      await supabase
        .from('epoch_holder_rewards')
        .update({ claimed: true, claimed_at: new Date().toISOString() })
        .in('id', claimableIds);

      return new Response(
        JSON.stringify({
          success: true,
          txHash: null,
          claimedEth: '0',
          alreadyClaimed: true,
          message: 'Rewards were already claimed on-chain.',
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: `On-chain claim execution failed: ${err.message}` }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // 5. ONLY AFTER on-chain confirmation, mark claimed in DB via service_role
  const claimedIds = claimableRows.map((r) => r.id);
  const totalClaimedWei = claimableRows.reduce((acc, r) => acc + r.amountWei, 0n);

  await supabase
    .from('epoch_holder_rewards')
    .update({
      claimed: true,
      claimed_at: new Date().toISOString(),
    })
    .in('id', claimedIds);

  return new Response(
    JSON.stringify({
      success: true,
      txHash,
      claimedEth: formatEther(totalClaimedWei),
      epochsClaimed: claimableRows.map((r) => r.epochNumber),
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// ----------------------------------------------------------------------------
// Deno / Edge Function Main Router
// ----------------------------------------------------------------------------
if (typeof Deno !== 'undefined' && Deno.serve) {
  Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders });
    }

    const url = new URL(req.url);
    const pathname = url.pathname;

    if (pathname.endsWith('/challenge') && req.method === 'POST') {
      return await handleChallenge(req);
    }
    if (pathname.endsWith('/verify') && req.method === 'POST') {
      return await handleVerify(req);
    }
    if (pathname.endsWith('/query') && req.method === 'POST') {
      return await handleQuery(req);
    }
    if (pathname.endsWith('/claim') && req.method === 'POST') {
      return await handleClaim(req);
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  });
}
