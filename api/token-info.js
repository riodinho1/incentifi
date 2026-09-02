import { createPublicClient, http, parseAbi, getAddress, isAddress } from 'viem';

const RPC_URL = process.env.VITE_EVM_RPC_URL || process.env.EVM_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const FACTORY_ADDRESS = '0x9fcea653c6f31c82606582b22da82b39f61f9c0e';
const ROUTER_ADDRESS = '0xbba0384bf34b5cc26daa2c06cdf765bbdeb2acdf';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const client = createPublicClient({
  transport: http(RPC_URL),
});

const TOKEN_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function creator() view returns (address)',
]);

const FACTORY_ABI = parseAbi([
  'function getBondingCurve(address token) view returns (address)',
  'function isGraduated(address token) view returns (bool)',
]);

const CURVE_ABI = parseAbi([
  'function realEthReserve() view returns (uint256)',
  'function realTokenReserve() view returns (uint256)',
  'function getCurrentPrice() view returns (uint256)',
  'function getProgressBps() view returns (uint256)',
  'function graduated() view returns (bool)',
  'function uniswapPool() view returns (address)',
]);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const rawAddress = req.query?.address;
  if (!rawAddress || typeof rawAddress !== 'string' || !isAddress(rawAddress)) {
    res.status(400).json({
      error: 'Invalid or missing "address" parameter. Must be a 20-byte EVM hex address (0x...).',
    });
    return;
  }

  const tokenAddress = getAddress(rawAddress);

  try {
    // 1. Fetch Token Metadata
    let name = 'Unknown Token';
    let symbol = 'UNKNOWN';
    let decimals = 18;
    let totalSupply = '1000000000000000000000000000';
    let creator = null;

    try {
      name = await client.readContract({
        address: tokenAddress,
        abi: TOKEN_ABI,
        functionName: 'name',
      });
      symbol = await client.readContract({
        address: tokenAddress,
        abi: TOKEN_ABI,
        functionName: 'symbol',
      });
      decimals = await client.readContract({
        address: tokenAddress,
        abi: TOKEN_ABI,
        functionName: 'decimals',
      });
      const supply = await client.readContract({
        address: tokenAddress,
        abi: TOKEN_ABI,
        functionName: 'totalSupply',
      });
      totalSupply = supply.toString();
    } catch {
      // Contract might not exist at address
      const code = await client.getBytecode({ address: tokenAddress });
      if (!code || code === '0x') {
        res.status(404).json({
          error: `No contract deployed at address ${tokenAddress}`,
        });
        return;
      }
    }

    try {
      creator = await client.readContract({
        address: tokenAddress,
        abi: TOKEN_ABI,
        functionName: 'creator',
      });
    } catch {
      // creator() is optional on generic ERC20s
    }

    // 2. Query Incentifi Factory for Bonding Curve
    const curveAddress = await client.readContract({
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI,
      functionName: 'getBondingCurve',
      args: [tokenAddress],
    });

    const hasCurve = curveAddress && curveAddress !== ZERO_ADDRESS;

    let graduated = false;
    let currentPriceWei = '0';
    let currentPriceEth = 0;
    let progressBps = 0;
    let realEthReserveWei = '0';
    let realTokenReserveWei = '0';
    let uniswapPool = null;

    if (hasCurve) {
      graduated = await client.readContract({
        address: FACTORY_ADDRESS,
        abi: FACTORY_ABI,
        functionName: 'isGraduated',
        args: [tokenAddress],
      });

      const [realEth, realTokens, spotPrice, progress, pool] = await Promise.all([
        client.readContract({ address: curveAddress, abi: CURVE_ABI, functionName: 'realEthReserve' }),
        client.readContract({ address: curveAddress, abi: CURVE_ABI, functionName: 'realTokenReserve' }),
        client.readContract({ address: curveAddress, abi: CURVE_ABI, functionName: 'getCurrentPrice' }),
        client.readContract({ address: curveAddress, abi: CURVE_ABI, functionName: 'getProgressBps' }),
        client.readContract({ address: curveAddress, abi: CURVE_ABI, functionName: 'uniswapPool' }),
      ]);

      realEthReserveWei = realEth.toString();
      realTokenReserveWei = realTokens.toString();
      currentPriceWei = spotPrice.toString();
      currentPriceEth = Number(spotPrice) / 1e18;
      progressBps = Number(progress);
      uniswapPool = pool && pool !== ZERO_ADDRESS ? pool : null;
    }

    res.status(200).json({
      address: tokenAddress,
      name,
      symbol,
      decimals,
      totalSupply,
      creator,
      bondingCurve: hasCurve ? curveAddress : null,
      graduated,
      currentPriceWei,
      currentPriceEth,
      progressBps,
      progressPercent: (progressBps / 100).toFixed(2) + '%',
      realEthReserveWei,
      realEthReserveEth: (Number(realEthReserveWei) / 1e18).toFixed(6),
      realTokenReserveWei,
      realTokenReserveTokens: (Number(realTokenReserveWei) / 1e18).toFixed(2),
      uniswapPool,
      router: ROUTER_ADDRESS,
      factory: FACTORY_ADDRESS,
      chainId: 4663,
      chainName: 'Robinhood Chain Mainnet',
    });
  } catch (err) {
    res.status(500).json({
      error: `Failed to fetch token market state: ${err.message}`,
    });
  }
}
