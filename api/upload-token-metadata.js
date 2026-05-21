const LOGO_URL =
  'https://static.readdy.ai/image/97719340ed94173328dfb1241fbbf19e/51991647bb900b0ff0ac5e8230d485ae.png';

const clean = (value, fallback = '') => String(value || fallback).trim();

const readJsonBody = (request) =>
  new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });

const makeFallbackUri = (host, mint, name, symbol) => {
  const safeHost =
    host && !host.includes('localhost') && !host.includes('127.0.0.1')
      ? host
      : 'incentifi.fun';
  const url = new URL('/api/token-metadata', `https://${safeHost}`);
  if (mint) url.searchParams.set('mint', mint);
  if (name) url.searchParams.set('n', name);
  if (symbol) url.searchParams.set('s', symbol);
  return url.toString();
};

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    response.status(204).end();
    return;
  }

  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const input = await readJsonBody(request);
  const name = clean(input.tokenName, 'incentifi token').slice(0, 32);
  const symbol = clean(input.tokenSymbol, 'INCENTIFI').toUpperCase().slice(0, 10);
  const mint = clean(input.mint);
  const host = request.headers.host || 'incentifi.fun';
  const fallbackUri = makeFallbackUri(host, mint, name, symbol);
  const pinataJwt = process.env.PINATA_JWT;

  if (!pinataJwt) {
    response.status(200).json({
      uri: fallbackUri,
      provider: 'site-fallback',
      warning: 'PINATA_JWT is not configured; using site metadata fallback.',
    });
    return;
  }

  const metadata = {
    name,
    symbol,
    description: clean(
      input.description,
      'Created on incentifi, a Solana launch platform for holder-aligned markets.'
    ),
    image: clean(input.imageUrl, LOGO_URL),
    external_url: clean(input.website, 'https://incentifi.fun'),
    twitter: clean(input.twitter),
    telegram: clean(input.telegram),
    website: clean(input.website, 'https://incentifi.fun'),
    createdOn: 'https://incentifi.fun',
  };

  const formData = new FormData();
  const file = new Blob([JSON.stringify(metadata, null, 2)], {
    type: 'application/json',
  });
  formData.append('file', file, `${symbol.toLowerCase()}-${mint || Date.now()}.json`);
  formData.append('network', 'public');

  const uploadResponse = await fetch('https://uploads.pinata.cloud/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pinataJwt}`,
    },
    body: formData,
  });

  if (!uploadResponse.ok) {
    const message = await uploadResponse.text();
    response.status(502).json({
      error: 'Pinata metadata upload failed',
      detail: message,
    });
    return;
  }

  const upload = await uploadResponse.json();
  const cid = upload?.data?.cid || upload?.IpfsHash;

  if (!cid) {
    response.status(502).json({
      error: 'Pinata metadata upload did not return a CID',
      detail: upload,
    });
    return;
  }

  response.status(200).json({
    uri: `https://ipfs.io/ipfs/${cid}`,
    cid,
    provider: 'pinata',
  });
}
