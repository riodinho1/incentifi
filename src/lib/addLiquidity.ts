import { encodeFunctionData, decodeEventLog, parseAbi, getAddress } from 'viem';
import { getEvmProvider } from './evmNetwork';
import {
  UNISWAP_POSITION_MANAGER,
  WETH_ADDRESS,
  BURN_ADDRESS,
  POOL_FEE,
  TICK_LOWER,
  TICK_UPPER,
} from './uniswapAddresses';

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
]);

const POSITION_MANAGER_ABI = parseAbi([
  'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)',
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function refundETH() payable',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
]);

const TRANSFER_EVENT_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const toQuantityHex = (value: bigint) => `0x${value.toString(16)}`;

const isqrt = (value: bigint): bigint => {
  if (value < 2n) return value;
  let x0 = value;
  let x1 = (x0 + 1n) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) >> 1n;
  }
  return x0;
};

const computeSqrtPriceX96 = (token0Amount: bigint, token1Amount: bigint): bigint => {
  const numerator = token1Amount * (1n << 192n);
  return isqrt(numerator / token0Amount);
};

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

const readTokenBalance = async (tokenAddress: `0x${string}`, owner: `0x${string}`) => {
  const provider = getEvmProvider();
  if (!provider) throw new Error('Wallet provider not available.');

  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [owner],
  });

  const result = await provider.request({
    method: 'eth_call',
    params: [{ to: tokenAddress, data }, 'latest'],
  });

  return BigInt(result);
};

export type AddLiquidityResult = {
  poolTxHash: string;
  lockTxHash: string;
  tokenId: string;
};

export const addLiquidityAndLock = async (
  tokenAddress: string,
  creatorAddress: string,
  ethAmount: string | number
): Promise<AddLiquidityResult> => {
  const provider = getEvmProvider();
  if (!provider) throw new Error('Connect wallet first.');

  const token = getAddress(tokenAddress);
  const creator = getAddress(creatorAddress);
  const weth = getAddress(WETH_ADDRESS);

  const ethWei = BigInt(Math.round(Number(ethAmount) * 1e18));
  if (ethWei <= 0n) throw new Error('Enter a valid ETH amount for liquidity.');

  const tokenBalance = await readTokenBalance(token, creator);
  if (tokenBalance <= 0n) throw new Error('No token balance available to seed liquidity with.');

  const isTokenFirst = BigInt(token) < BigInt(weth);
  const token0 = isTokenFirst ? token : weth;
  const token1 = isTokenFirst ? weth : token;
  const amount0 = isTokenFirst ? tokenBalance : ethWei;
  const amount1 = isTokenFirst ? ethWei : tokenBalance;

  const sqrtPriceX96 = computeSqrtPriceX96(amount0, amount1);

  // Approve the position manager to pull the new token into the pool.
  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [UNISWAP_POSITION_MANAGER, tokenBalance],
  });
  const approveTxHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: creator, to: token, data: approveData }],
  });
  await waitForReceipt(approveTxHash);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 20);

  const createPoolData = encodeFunctionData({
    abi: POSITION_MANAGER_ABI,
    functionName: 'createAndInitializePoolIfNecessary',
    args: [token0, token1, POOL_FEE, sqrtPriceX96],
  });

  const mintData = encodeFunctionData({
    abi: POSITION_MANAGER_ABI,
    functionName: 'mint',
    args: [
      {
        token0,
        token1,
        fee: POOL_FEE,
        tickLower: TICK_LOWER,
        tickUpper: TICK_UPPER,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: creator,
        deadline,
      },
    ],
  });

  const refundEthData = encodeFunctionData({
    abi: POSITION_MANAGER_ABI,
    functionName: 'refundETH',
  });

  const multicallData = encodeFunctionData({
    abi: POSITION_MANAGER_ABI,
    functionName: 'multicall',
    args: [[createPoolData, mintData, refundEthData]],
  });

  const poolTxHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: creator,
        to: UNISWAP_POSITION_MANAGER,
        data: multicallData,
        value: toQuantityHex(ethWei),
      },
    ],
  });

  const poolReceipt = await waitForReceipt(poolTxHash);

  let tokenId: bigint | undefined;
  for (const log of poolReceipt.logs || []) {
    if (String(log.address).toLowerCase() !== UNISWAP_POSITION_MANAGER.toLowerCase()) continue;
    try {
      const decoded: any = decodeEventLog({ abi: TRANSFER_EVENT_ABI, data: log.data, topics: log.topics });
      const args = decoded.args as { from: string; to: string; tokenId: bigint };
      if (String(args.from).toLowerCase() === ZERO_ADDRESS) {
        tokenId = args.tokenId;
        break;
      }
    } catch {
      // Not a Transfer event on this contract - skip.
    }
  }

  if (tokenId === undefined) {
    throw new Error('Liquidity transaction confirmed, but the new position could not be identified.');
  }

  // Lock the position permanently by sending it to the burn address.
  const lockData = encodeFunctionData({
    abi: POSITION_MANAGER_ABI,
    functionName: 'safeTransferFrom',
    args: [creator, BURN_ADDRESS, tokenId],
  });

  const lockTxHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: creator, to: UNISWAP_POSITION_MANAGER, data: lockData }],
  });
  await waitForReceipt(lockTxHash);

  return {
    poolTxHash,
    lockTxHash,
    tokenId: tokenId.toString(),
  };
};
