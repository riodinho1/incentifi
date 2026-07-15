import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const clean = (value, fallback = '') => String(value || fallback).trim();
const PUMPPORTAL_LIGHTNING_FEE_RATE = 0.01;
const PUMP_BONDING_CURVE_FEE_RATE = 0.0125;
const LAUNCH_FEE_BUFFER_SOL = 0.0001;

const getFundedInitialBuy = (input) => {
  const funding = Math.max(0.0001, Number(input.initialLiquidity || 0.01) || 0.01);
  const amountAfterFixedBuffer = Math.max(0.0001, funding - LAUNCH_FEE_BUFFER_SOL);
  const rateBuffer = 1 + PUMPPORTAL_LIGHTNING_FEE_RATE + PUMP_BONDING_CURVE_FEE_RATE;
  return Number(Math.max(0.0001, amountAfterFixedBuffer / rateBuffer).toFixed(9));
};

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

  response.status(501).json({ error: 'Solana-based PumpPortal disabled. EVM-only mode active.' });
}
