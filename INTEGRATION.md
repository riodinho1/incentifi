# Incentifi Developer & Trading Terminal Integration Guide

Welcome to the Incentifi Developer Integration Guide. This document provides complete technical specifications for third-party trading terminals, Telegram trading bots, DEX aggregators, market makers, and developers looking to integrate Incentifi tokens on **Robinhood Chain Mainnet**.

---

## 1. Network Configuration

| Parameter | Value |
| :--- | :--- |
| **Network Name** | Robinhood Chain Mainnet |
| **Chain ID** | `4663` |
| **Native Gas Token** | `ETH` |
| **RPC Endpoint** | `https://rpc.mainnet.chain.robinhood.com` |
| **Block Explorer** | `https://explorer.mainnet.chain.robinhood.com` |

---

## 2. Canonical Smart Contract Addresses

| Contract Name | Address | Role |
| :--- | :--- | :--- |
| **IncentifiBondingCurveFactory** | `0x9fcea653c6f31c82606582b22da82b39f61f9c0e` | Registry & Curve Factory |
| **IncentifiSwapRouter** | `0xbba0384bf34b5cc26daa2c06cdf765bbdeb2acdf` | Unified Universal Swap Gateway |
| **LossRewardPool** | `0x697bda9db5a297a9cd9ed969bbf2549d0527dcdf` | Loss-Reward Staking & Protection Pool |
| **WETH** | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | Canonical Wrapped Ether |
| **Uniswap V3 Factory** | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` | Canonical DEX Factory |
| **Uniswap V3 PositionManager** | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` | Nonfungible Position Manager |
| **Uniswap V3 SwapRouter02** | `0xcaf681a66d020601342297493863e78c959e5cb2` | Underlying router `IncentifiSwapRouter` forwards post-graduation swaps to |
| **Uniswap V3 QuoterV2** | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` | Off-chain quote simulation for post-graduation swaps (`quoteExactInputSingle`/`quoteExactOutputSingle`) |

> All addresses above (including QuoterV2) are cross-checked against the [official Uniswap Robinhood Chain deployments page](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments) and confirmed to have live deployed bytecode via `eth_getCode` on Robinhood Chain mainnet. Uniswap's own docs note that `UniversalRouter` (`0x8876789976decbfcbbbe364623c63652db8c0904`) is now the preferred swap entrypoint, superseding `SwapRouter02` — Incentifi's router currently integrates against `SwapRouter02`, which remains deployed and functional but is not the newest option.

---

## 3. Protocol Architecture & Market Lifecycle

Every Incentifi token follows an atomic 2-phase market lifecycle:

```
[ PHASE 1: PRE-GRADUATION ]
Token launched -> 1,000,000,000 supply deposited into IncentifiBondingCurve
Trades route via: IncentifiSwapRouter (or direct IncentifiBondingCurve)
Fee: 2.0% (1.0% Creator Wallet / 1.0% LossRewardPool in native ETH)
Graduation Threshold: 5.853863 ETH accumulated in real reserves (~$69,000 market cap)

                    │
                    ▼ (Automatic Atomic Graduation)
[ PHASE 2: POST-GRADUATION ]
Uniswap V3 Pool automatically initialized (1.00% fee tier)
100% of Curve ETH + remaining Tokens seeded into full-range Uniswap V3 LP
LP NFT permanently burned to 0x000000000000000000000000000000000000dEaD
Trading routes via: IncentifiSwapRouter on Uniswap V3
```

> **Important Fee Note**: The 2.0% protocol fee (1% Creator / 1% LossRewardPool) is enforced at the router/curve level. Direct public Uniswap trading after graduation may bypass Incentifi's router-level 2% fee; the fee is enforced when swapping through `IncentifiSwapRouter`.

---

## 4. Token Discovery Flow

To determine if an arbitrary address is an Incentifi token and fetch its market status:

1. **Query Factory**: Call `getBondingCurve(tokenAddress)` on `0x9fcea653c6f31c82606582b22da82b39f61f9c0e`.
   * If result is `0x0000000000000000000000000000000000000000`, the token is not an active Incentifi bonding curve token.
   * If result is non-zero (`curveAddress`), the token is an active Incentifi token.
2. **Check Graduation State**: Call `isGraduated(tokenAddress)` on the Factory.
   * `false`: Token is trading on the **Incentifi Bonding Curve**.
   * `true`: Token has graduated and is trading on **Uniswap V3**.

---

## 5. Token Decimals & Units

* **Token Decimals**: Standard `18` decimals (`1.0 Token = 10^18 units`).
* **ETH Amounts**: Standard `18` decimals (`1.0 ETH = 10^18 wei`).
* **Total Token Supply**: Fixed `1,000,000,000` tokens (`1_000_000_000 * 10^18`).

---

## 6. Trading Execution via `IncentifiSwapRouter`

The `IncentifiSwapRouter` (`0xbba0384bf34b5cc26daa2c06cdf765bbdeb2acdf`) provides a **single unified gateway** for both pre-graduation and post-graduation trading.

### 6.1. Buying Tokens (`buyToken`)

Send native ETH via `msg.value`:

```solidity
function buyToken(
    address token,
    uint256 amountOutMinimum,
    uint256 deadline
) external payable returns (uint256 amountOut);
```

* `token`: Address of the ERC-20 token.
* `amountOutMinimum`: Minimum tokens expected (slippage protection).
* `deadline`: Unix timestamp (seconds) after which trade reverts.
* `msg.value`: Gross ETH amount to spend.

### 6.2. Selling Tokens (`sellToken`)

Requires a 1-time standard ERC-20 approval for `IncentifiSwapRouter`:

```solidity
// 1. Approve Router
IERC20(token).approve(0xbba0384bf34b5cc26daa2c06cdf765bbdeb2acdf, tokenAmountIn);

// 2. Execute Sell
function sellToken(
    address token,
    uint256 tokenAmountIn,
    uint256 minEthOut,
    uint256 deadline
) external returns (uint256 netEthOut);
```

* `token`: Address of the ERC-20 token.
* `tokenAmountIn`: Token units to sell.
* `minEthOut`: Minimum net ETH expected after 2% fee.
* `deadline`: Unix timestamp (seconds) after which trade reverts.

---

## 7. Public REST API (Lightweight Integration)

Incentifi provides read-only HTTP endpoints for terminals and bots that prefer REST over direct RPC:

### 7.1. Token Info Endpoint
```http
GET /api/token-info?address=0x<TOKEN_ADDRESS>
```

**Response Example:**
```json
{
  "address": "0x789b91...c3",
  "name": "Robin Meme",
  "symbol": "RMEME",
  "decimals": 18,
  "totalSupply": "1000000000000000000000000000",
  "bondingCurve": "0x542a18...f8",
  "graduated": false,
  "currentPriceEth": 0.000000002145,
  "progressBps": 1250,
  "progressPercent": "12.50%",
  "realEthReserveEth": "0.731732",
  "realTokenReserveTokens": "892145120.50",
  "uniswapPool": null,
  "router": "0xbba0384bf34b5cc26daa2c06cdf765bbdeb2acdf",
  "chainId": 4663
}
```

### 7.2. Exact Quote Endpoint
```http
GET /api/quote?token=0x<TOKEN_ADDRESS>&side=buy&amountEth=0.05
```

**Response Example:**
```json
{
  "token": "0x789b91...c3",
  "side": "buy",
  "graduated": false,
  "marketType": "Incentifi_Bonding_Curve",
  "inputAmountEth": "0.05",
  "inputAmountWei": "50000000000000000",
  "expectedTokensOut": "22451092.1284",
  "expectedTokensOutWei": "22451092128400000000000000",
  "creatorFeeEth": "0.0005",
  "lossRewardPoolFeeEth": "0.0005",
  "protocolFeeBps": 200,
  "spotPriceEth": 0.000000002227,
  "chainId": 4663
}
```

---

## 8. Integration Code Examples

### 8.1. Ethers.js v6 Example

```javascript
import { ethers } from 'ethers';

const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
const ROUTER_ADDRESS = '0xbba0384bf34b5cc26daa2c06cdf765bbdeb2acdf';

const ROUTER_ABI = [
  'function buyToken(address token, uint256 amountOutMinimum, uint256 deadline) external payable returns (uint256)',
  'function sellToken(address token, uint256 tokenAmountIn, uint256 minEthOut, uint256 deadline) external returns (uint256)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
];

// Initialize Provider & Signer
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(YOUR_PRIVATE_KEY, provider);
const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, signer);

// 1. BUY TOKEN (Spend 0.01 ETH with 1% slippage)
export async function buyIncentifiToken(tokenAddress, ethAmount = '0.01', minTokensOut = 0n) {
  const deadline = Math.floor(Date.now() / 1000) + 1200; // 20 min
  const tx = await router.buyToken(tokenAddress, minTokensOut, deadline, {
    value: ethers.parseEther(ethAmount),
  });
  console.log('Buy Tx Hash:', tx.hash);
  return await tx.wait();
}

// 2. SELL TOKEN (Sell 1,000,000 tokens)
export async function sellIncentifiToken(tokenAddress, tokenAmountFormatted = '1000000', minEthOut = 0n) {
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const tokenWei = ethers.parseEther(tokenAmountFormatted);

  // Approve Router
  const approveTx = await tokenContract.approve(ROUTER_ADDRESS, tokenWei);
  await approveTx.wait();

  // Execute Sell
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const tx = await router.sellToken(tokenAddress, tokenWei, minEthOut, deadline);
  console.log('Sell Tx Hash:', tx.hash);
  return await tx.wait();
}
```

### 8.2. Viem Example

```typescript
import { createWalletClient, createPublicClient, http, parseEther, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ROUTER_ADDRESS = '0xbba0384bf34b5cc26daa2c06cdf765bbdeb2acdf';

const robinhoodChain = {
  id: 4663,
  name: 'Robinhood Chain Mainnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
};

const ROUTER_ABI = parseAbi([
  'function buyToken(address token, uint256 amountOutMinimum, uint256 deadline) external payable returns (uint256 amountOut)',
  'function sellToken(address token, uint256 tokenAmountIn, uint256 minEthOut, uint256 deadline) external returns (uint256 netEthOut)',
]);

export async function buyTokenViem(accountPrivateKey: `0x${string}`, tokenAddress: `0x${string}`, ethAmount = '0.01') {
  const account = privateKeyToAccount(accountPrivateKey);
  const walletClient = createWalletClient({
    account,
    chain: robinhoodChain,
    transport: http(),
  });

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);

  const hash = await walletClient.writeContract({
    address: ROUTER_ADDRESS,
    abi: ROUTER_ABI,
    functionName: 'buyToken',
    args: [tokenAddress, 0n, deadline],
    value: parseEther(ethAmount),
  });

  console.log('Buy Transaction submitted:', hash);
  return hash;
}
```

---

## 9. Event Logging & Indexing Specifications

Indexers can listen to the following authoritative events on Robinhood Chain (`Chain ID: 4663`):

### 9.1. Token Launch Event (From Factory: `0x9fce...9c0e`)
```solidity
event BondingCurveCreated(
    address indexed token,
    address indexed curve,
    address indexed creator,
    uint256 initialInventory
);
```

### 9.2. Universal Trade Event (From Router: `0xbba0...acdf`)
```solidity
event IncentifiTrade(
    address indexed token,
    address indexed trader,
    bool indexed isBuy,
    uint256 ethAmount,
    uint256 tokenAmount,
    uint256 creatorFee,
    uint256 lossPoolFee
);
```

### 9.3. Graduation Event (From BondingCurve Instance)
```solidity
event Graduated(
    address indexed pool,
    uint256 tokenId,
    uint256 wethAmount,
    uint256 tokenAmount
);
```

---

## 10. Third-Party Trading Terminal Integration

For third-party trading terminals (such as GMGN, Axiom, DEXScreener, GeckoTerminal, Maestro, Trojan, Banana Gun, Photon, BullX) to enable instant token discovery and trading by contract address:

1. **Robinhood Chain Support**: The terminal must support Robinhood Chain (Chain ID `4663`).
2. **Factory Registration**: Register Factory address `0x9fcea653c6f31c82606582b22da82b39f61f9c0e` in the platform's launchpad parser.
3. **Router Routing**: Route pre-graduation buy/sell orders through `IncentifiSwapRouter` (`0xbba0384bf34b5cc26daa2c06cdf765bbdeb2acdf`).
4. **Post-Graduation**: After `isGraduated(token) == true`, terminals can route either through `IncentifiSwapRouter` or standard Robinhood Chain Uniswap V3 infrastructure (`0x1f7d...2EfA`).

*Note: Integrations with third-party terminals require platform-side integration/adaptation.*

---

## 11. Security & Non-Custodial Guarantee

* The Incentifi integration layer is **100% non-custodial**.
* No private keys or custodial access are required or accepted by Incentifi APIs.
* All smart contract trading operations execute through direct cryptographic user signatures via self-custody wallets or trading bot private keys.
