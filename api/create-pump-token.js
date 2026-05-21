import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

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

  const apiKey = process.env.PUMPPORTAL_API_KEY;
  if (!apiKey) {
    response.status(500).json({
      error:
        'PumpPortal local create is currently failing, and PUMPPORTAL_API_KEY is not configured for Lightning fallback.',
    });
    return;
  }

  const input = await readJsonBody(request);
  const mint = Keypair.generate();
  const name = clean(input.tokenName, 'incentifi token').slice(0, 32);
  const symbol = clean(input.tokenSymbol, 'INCENTIFI').toUpperCase().slice(0, 10);
  const uri = clean(input.metadataUri);
  const amount = Math.max(0.0001, Number(input.initialLiquidity || 0.01) || 0.01);

  if (!uri) {
    response.status(400).json({ error: 'Missing metadataUri.' });
    return;
  }

  const pumpResponse = await fetch(`https://pumpportal.fun/api/trade?api-key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'create',
      tokenMetadata: {
        name,
        symbol,
        uri,
      },
      mint: bs58.encode(mint.secretKey),
      denominatedInSol: 'true',
      amount,
      slippage: 15,
      priorityFee: 0.00005,
      pool: 'pump',
    }),
  });

  if (!pumpResponse.ok) {
    const message = await pumpResponse.text();
    response.status(pumpResponse.status).json({
      error: `PumpPortal Lightning create failed. ${message || pumpResponse.statusText}`,
    });
    return;
  }

  const result = await pumpResponse.json();
  response.status(200).json({
    mint: mint.publicKey.toBase58(),
    signature: result.signature,
    explorer: `https://explorer.solana.com/address/${mint.publicKey.toBase58()}`,
    txExplorer: result.signature ? `https://explorer.solana.com/tx/${result.signature}` : '',
  });
}
