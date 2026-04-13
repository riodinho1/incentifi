import { Connection } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const SYMBOL = (process.env.TOKEN_SYMBOL || '').toUpperCase();
const LIMIT = Number(process.env.VERIFY_LIMIT || 100);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SYMBOL) {
  console.error('Missing env vars. Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TOKEN_SYMBOL');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const connection = new Connection(RPC_URL, 'confirmed');

const run = async () => {
  const { data: trades, error } = await supabase
    .from('token_trades')
    .select('signature, symbol, mint_address')
    .eq('symbol', SYMBOL)
    .order('block_time', { ascending: false })
    .limit(LIMIT);
  if (error) throw error;

  let checked = 0;
  let verified = 0;
  let failed = 0;

  for (const trade of trades || []) {
    const signature = trade.signature;
    if (!signature) continue;
    checked += 1;
    try {
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      const ok = Boolean(tx && tx.meta && !tx.meta.err);
      if (ok) verified += 1;
      else failed += 1;

      const { error: upsertErr } = await supabase.from('token_trade_verifications').upsert(
        {
          signature,
          symbol: trade.symbol,
          mint_address: trade.mint_address,
          verified: ok,
          verifier: 'rpc-check',
          verify_error: ok ? '' : 'transaction-not-confirmed-or-errored',
          verified_at: new Date().toISOString(),
        },
        { onConflict: 'signature' }
      );
      if (upsertErr) throw upsertErr;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      await supabase.from('token_trade_verifications').upsert(
        {
          signature,
          symbol: trade.symbol,
          mint_address: trade.mint_address,
          verified: false,
          verifier: 'rpc-check',
          verify_error: message.slice(0, 400),
          verified_at: new Date().toISOString(),
        },
        { onConflict: 'signature' }
      );
    }
  }

  console.log(
    `verify complete symbol=${SYMBOL} checked=${checked} verified=${verified} failed=${failed}`
  );
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
