import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey =
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const rawSymbol = req.query?.symbol;
  if (!rawSymbol || typeof rawSymbol !== 'string') {
    res.status(400).json({ error: 'Missing symbol query parameter' });
    return;
  }

  const symbol = rawSymbol.trim().toUpperCase();

  if (!supabaseUrl || !supabaseKey) {
    res.status(503).json({
      error: 'Symbol registry database is not configured on the server.',
      configured: false,
    });
    return;
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data, error } = await supabase
      .from('tokens')
      .select('id, symbol')
      .eq('symbol', symbol)
      .limit(1);

    if (error) {
      res.status(502).json({
        error: `Database query failed: ${error.message}`,
        details: error,
      });
      return;
    }

    const exists = Array.isArray(data) && data.length > 0;
    res.status(200).json({
      symbol,
      available: !exists,
      exists,
    });
  } catch (err) {
    res.status(500).json({
      error: `Internal symbol check error: ${err.message}`,
    });
  }
}
