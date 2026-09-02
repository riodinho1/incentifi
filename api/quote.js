import { createPublicClient, http, parseAbi, parseEther, formatEther, getAddress, isAddress } from 'viem';

const RPC_URL = process.env.VITE_EVM_RPC_URL || process.env.EVM_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const FACTORY_ADDRESS = '0x9fcea653c6f31c82606582b22da82b39f61f9c0e';
const ROUTER_ADDRESS = '0xbba0384bf34b5cc26daa2c06cdf765bbdeb2acdf';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const client = createPublicClient({
  transport: http(RPC_URL),
});

const FACTORY_ABI = parseAbi([
  'function getBondingCurve(address token) view returns (address)',
  'function isGraduated(address token) view returns (bool)',
]);

const CURVE_ABI = parseAbi([
  'function getAmountOutTokens(uint256 grossEthIn) view returns (uint256 tokensOut, uint256 creatorFee, uint256 lossPoolFee)',
  'function getAmountOutEth(uint256 tokensIn) view returns (uint256 netEthOut, uint256 creatorFee, uint256 lossPoolFee)',
  'function getCurrentPrice() view returns (uint256)',
  'function graduated() view returns (bool)',
]);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const rawToken = req.query?.token;
  const rawSide = (req.query?.side || 'buy').toLowerCase();
  const rawAmountEth = req.query?.amountEth || req.query?.amount;
  const rawAmountTokens = req.query?.amountTokens || req.query?.tokens;

  if (!rawToken || typeof rawToken !== 'string' || !isAddress(rawToken)) {
    res.status(400).json({
      error: 'Invalid or missing "token" address parameter.',
    });
    return;
  }

  if (rawSide !== 'buy' && rawSide !== 'sell') {
    res.status(400).json({
      error: 'Invalid "side" parameter. Must be either "buy" or "sell".',
    });
    return;
  }

  const tokenAddress = getAddress(rawToken);

  try {
    // 1. Resolve Bonding Curve from Factory
    const curveAddress = await client.readContract({
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI,
      functionName: 'getBondingCurve',
      args: [tokenAddress],
    });

    if (!curveAddress || curveAddress === ZERO_ADDRESS) {
      res.status(404).json({
        error: `No Incentifi bonding curve registered for token ${tokenAddress}.`,
        token: tokenAddress,
      });
      return;
    }

    const graduated = await client.readContract({
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI,
      functionName: 'isGraduated',
      args: [tokenAddress],
    });

    if (graduated) {
      res.status(200).json({
        token: tokenAddress,
        side: rawSide,
        graduated: true,
        marketType: 'Uniswap_V3',
        router: ROUTER_ADDRESS,
        message: 'Token has graduated to Uniswap V3. Use IncentifiSwapRouter for post-graduation trading.',
        chainId: 4663,
      });
      return;
    }

    // 2. Compute Pre-Graduation Quote from On-Chain Curve
    if (rawSide === 'buy') {
      if (!rawAmountEth || isNaN(Number(rawAmountEth)) || Number(rawAmountEth) <= 0) {
        res.status(400).json({ error: 'Missing or invalid "amountEth" parameter for buy quote.' });
        return;
      }

      const grossEthWei = parseEther(String(rawAmountEth));
      const [tokensOutWei, creatorFeeWei, lossPoolFeeWei] = await client.readContract({
        address: curveAddress,
        abi: CURVE_ABI,
        functionName: 'getAmountOutTokens',
        args: [grossEthWei],
      });

      const spotPriceWei = await client.readContract({
        address: curveAddress,
        abi: CURVE_ABI,
        functionName: 'getCurrentPrice',
      });

      const tokensOut = formatEther(tokensOutWei);
      const creatorFeeEth = formatEther(creatorFeeWei);
      const lossPoolFeeEth = formatEther(lossPoolFeeWei);
      const spotPriceEth = Number(spotPriceWei) / 1e18;

      res.status(200).json({
        token: tokenAddress,
        side: 'buy',
        graduated: false,
        marketType: 'Incentifi_Bonding_Curve',
        curveAddress,
        routerAddress: ROUTER_ADDRESS,
        inputAmountEth: String(rawAmountEth),
        inputAmountWei: grossEthWei.toString(),
        expectedTokensOut: tokensOut,
        expectedTokensOutWei: tokensOutWei.toString(),
        creatorFeeEth,
        creatorFeeWei: creatorFeeWei.toString(),
        lossRewardPoolFeeEth: lossPoolFeeEth,
        lossRewardPoolFeeWei: lossPoolFeeWei.toString(),
        protocolFeeBps: 200,
        spotPriceEth,
        spotPriceWei: spotPriceWei.toString(),
        chainId: 4663,
      });
    } else {
      // SELL QUOTE
      if (!rawAmountTokens || isNaN(Number(rawAmountTokens)) || Number(rawAmountTokens) <= 0) {
        res.status(400).json({ error: 'Missing or invalid "amountTokens" parameter for sell quote.' });
        return;
      }

      const tokensInWei = parseEther(String(rawAmountTokens));
      const [netEthOutWei, creatorFeeWei, lossPoolFeeWei] = await client.readContract({
        address: curveAddress,
        abi: CURVE_ABI,
        functionName: 'getAmountOutEth',
        args: [tokensInWei],
      });

      const spotPriceWei = await client.readContract({
        address: curveAddress,
        abi: CURVE_ABI,
        functionName: 'getCurrentPrice',
      });

      const netEthOut = formatEther(netEthOutWei);
      const creatorFeeEth = formatEther(creatorFeeWei);
      const lossPoolFeeEth = formatEther(lossPoolFeeWei);
      const spotPriceEth = Number(spotPriceWei) / 1e18;

      res.status(200).json({
        token: tokenAddress,
        side: 'sell',
        graduated: false,
        marketType: 'Incentifi_Bonding_Curve',
        curveAddress,
        routerAddress: ROUTER_ADDRESS,
        inputTokens: String(rawAmountTokens),
        inputTokensWei: tokensInWei.toString(),
        expectedNetEthOut: netEthOut,
        expectedNetEthOutWei: netEthOutWei.toString(),
        creatorFeeEth,
        creatorFeeWei: creatorFeeWei.toString(),
        lossRewardPoolFeeEth: lossPoolFeeEth,
        lossRewardPoolFeeWei: lossPoolFeeWei.toString(),
        protocolFeeBps: 200,
        spotPriceEth,
        spotPriceWei: spotPriceWei.toString(),
        chainId: 4663,
      });
    }
  } catch (err) {
    res.status(500).json({
      error: `Failed to compute quote: ${err.message}`,
    });
  }
}
