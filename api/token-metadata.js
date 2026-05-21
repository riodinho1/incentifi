const LOGO_URL =
  'https://static.readdy.ai/image/97719340ed94173328dfb1241fbbf19e/51991647bb900b0ff0ac5e8230d485ae.png';

const clean = (value, fallback = '') => String(value || fallback).trim();

const fetchToken = async (mint) => {
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey || !mint) return null;

  const url = new URL('/rest/v1/tokens', supabaseUrl);
  url.searchParams.set('mint_address', `eq.${mint}`);
  url.searchParams.set(
    'select',
    'name,symbol,description,image_url,website,twitter,telegram'
  );
  url.searchParams.set('limit', '1');

  const response = await fetch(url, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
    },
  });

  if (!response.ok) return null;
  const rows = await response.json();
  return rows?.[0] || null;
};

export default async function handler(request, response) {
  const mint = clean(request.query?.mint);
  const fallbackName = clean(request.query?.n, 'incentifi token');
  const fallbackSymbol = clean(request.query?.s, 'INCENTIFI').toUpperCase();
  const token = await fetchToken(mint);

  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  response.status(200).json({
    name: clean(token?.name, fallbackName),
    symbol: clean(token?.symbol, fallbackSymbol).toUpperCase(),
    description: clean(
      token?.description,
      'Created on incentifi, a Solana launch platform for holder-aligned markets.'
    ),
    image: clean(token?.image_url, LOGO_URL),
    external_url: clean(token?.website, 'https://incentifi.fun'),
    twitter: clean(token?.twitter),
    telegram: clean(token?.telegram),
    website: clean(token?.website, 'https://incentifi.fun'),
    createdOn: 'https://incentifi.fun',
  });
}
