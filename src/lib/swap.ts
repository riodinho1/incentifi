import { encodeFunctionData, parseAbi, getAddress } from 'viem';
import { getEvmProvider } from './evmNetwork';
import { UNISWAP_V3_FACTORY, UNISWAP_SWAP_ROUTER, WETH_ADDRESS, POOL_FEE } from './uniswapAddresses';

const FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
]);

const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const SWAP_ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
]);

const toQuantityHex = (value: bigint) => `0x${value.toString(16)}`;

const waitForReceipt = async (txHash: string) => {
  const provider = getEvmProvider();
  if (!provider) throw new Error('Wallet provider disappeared while waiting for confirmation.');

  for (let attempt = 0; attempt < 90; attempt += 1) {
    const receipt = await provider.request({
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    });
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('Transaction was submitted, but confirmation timed out.');
};

const call = async (to: `0x${string}`, data: `0x${string}`) => {
  const provider = getEvmProvider();
  if (!provider) throw new Error('Wallet provider not available.');
  return provider.request({ method: 'eth_call', params: [{ to, data }, 'latest'] });
};

export const getPoolQuote = async (tokenAddress: string) => {
  const token = getAddress(tokenAddress);
  const weth = getAddress(WETH_ADDRESS);

  const getPoolData = encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: 'getPool',
    args: [token, weth, POOL_FEE],
  });
  const poolResult = await call(UNISWAP_V3_FACTORY, getPoolData);
  const poolAddress = `0x${String(poolResult).slice(-40)}` as `0x${string}`;

  if (BigInt(poolAddress) === 0n) {
    throw new Error('No liquidity pool found for this token yet.');
  }

  const slot0Data = encodeFunctionData({ abi: POOL_ABI, functionName: 'slot0' });
  const slot0Result = await call(poolAddress, slot0Data);
  const sqrtPriceX96 = BigInt(`0x${String(slot0Result).slice(2, 2 + 64)}`);

  if (sqrtPriceX96 <= 0n) {
    throw new Error('Pool exists but has no price yet.');
  }

  const isTokenFirst = BigInt(token) < BigInt(weth);

  return { poolAddress, sqrtPriceX96, isTokenFirst };
};

const applySlippage = (amount: bigint, slippageBps: number) => {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))));
  return (amount * (10_000n - bps)) / 10_000n;
};

// amountOut (raw) for swapping amountIn of token0 -> token1, or the inverse.
const quoteAmountOut = (
  amountIn: bigint,
  sqrtPriceX96: bigint,
  inIsToken0: boolean
): bigint => {
  const Q192 = 1n << 192n;
  if (inIsToken0) {
    return (amountIn * sqrtPriceX96 * sqrtPriceX96) / Q192;
  }
  return (amountIn * Q192) / (sqrtPriceX96 * sqrtPriceX96);
};

export type SwapResult = {
  txHash: string;
};

export const buyToken = async (
  tokenAddress: string,
  trader: string,
  ethAmount: string | number,
  slippagePct: number
): Promise<SwapResult> => {
  const provider = getEvmProvider();
  if (!provider) throw new Error('Connect wallet first.');

  const token = getAddress(tokenAddress);
  const weth = getAddress(WETH_ADDRESS);
  const traderAddr = getAddress(trader);

  const ethWei = BigInt(Math.round(Number(ethAmount) * 1e18));
  if (ethWei <= 0n) throw new Error('Enter a valid ETH amount.');

  const { sqrtPriceX96, isTokenFirst } = await getPoolQuote(token);
  // Buying: ETH (WETH) in, token out. WETH is token0 if !isTokenFirst, else token1.
  const wethIsToken0 = !isTokenFirst;
  const expectedOut = quoteAmountOut(ethWei, sqrtPriceX96, wethIsToken0);
  const amountOutMinimum = applySlippage(expectedOut, slippagePct * 100);

  const swapData = encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: weth,
        tokenOut: token,
        fee: POOL_FEE,
        recipient: traderAddr,
        amountIn: ethWei,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [
      { from: traderAddr, to: UNISWAP_SWAP_ROUTER, data: swapData, value: toQuantityHex(ethWei) },
    ],
  });
  await waitForReceipt(txHash);

  return { txHash };
};

export const sellToken = async (
  tokenAddress: string,
  trader: string,
  tokenAmount: string | number,
  tokenDecimals: number,
  slippagePct: number
): Promise<SwapResult> => {
  const provider = getEvmProvider();
  if (!provider) throw new Error('Connect wallet first.');

  const token = getAddress(tokenAddress);
  const weth = getAddress(WETH_ADDRESS);
  const traderAddr = getAddress(trader);

  const tokenWei = BigInt(Math.round(Number(tokenAmount) * 10 ** tokenDecimals));
  if (tokenWei <= 0n) throw new Error('Enter a valid token amount.');

  const { sqrtPriceX96, isTokenFirst } = await getPoolQuote(token);
  const expectedOut = quoteAmountOut(tokenWei, sqrtPriceX96, isTokenFirst);
  const amountOutMinimum = applySlippage(expectedOut, slippagePct * 100);

  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [UNISWAP_SWAP_ROUTER, tokenWei],
  });
  const approveTxHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: traderAddr, to: token, data: approveData }],
  });
  await waitForReceipt(approveTxHash);

  const swapData = encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: token,
        tokenOut: weth,
        fee: POOL_FEE,
        recipient: UNISWAP_SWAP_ROUTER,
        amountIn: tokenWei,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

  const unwrapData = encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: 'unwrapWETH9',
    args: [amountOutMinimum, traderAddr],
  });

  const multicallData = encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: 'multicall',
    args: [[swapData, unwrapData]],
  });

  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: traderAddr, to: UNISWAP_SWAP_ROUTER, data: multicallData }],
  });
  await waitForReceipt(txHash);

  return { txHash };
};
