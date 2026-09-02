import React, { useState, useEffect, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import WalletButton from '../../components/WalletButton';
import { useWalletConnected } from '../../hooks/useWalletConnected';
import {
  getWalletAccount,
  setWalletAccount,
  subscribeWalletAccount,
} from '../../lib/walletAccount';
import {
  EVM_CHAIN_ID_HEX,
  EVM_CHAIN_NAME,
  EVM_EXPLORER_URL,
  EVM_RPC_URL,
  EVM_TX_URL,
  EVM_ADDRESS_URL,
  ensureEvmChain,
  getEvmProvider,
  requestEvmAccounts,
} from '../../lib/evmNetwork';
import {
  LOSS_REWARD_POOL_FULL_DEPLOY_DATA,
} from '../../lib/lossRewardPoolBytecode';
import {
  INCENTIFI_FACTORY_FULL_DEPLOY_DATA,
  INCENTIFI_FACTORY_CONSTRUCTOR_ARGS,
  FACTORY_CONSTRUCTOR_PARAMS,
} from '../../lib/incentifiBondingCurveFactoryBytecode';
import {
  INCENTIFI_ROUTER_FULL_DEPLOY_DATA,
  INCENTIFI_ROUTER_CONSTRUCTOR_ARGS,
  ROUTER_CONSTRUCTOR_PARAMS,
} from '../../lib/incentifiSwapRouterBytecode';
import {
  LOSS_REWARD_POOL,
  INCENTIFI_BONDING_CURVE_FACTORY,
  INCENTIFI_SWAP_ROUTER,
  WETH_ADDRESS,
  UNISWAP_SWAP_ROUTER,
  UNISWAP_POSITION_MANAGER,
  UNISWAP_V3_FACTORY,
} from '../../lib/uniswapAddresses';

type DeploymentTarget = 'router' | 'factory' | 'lossRewardPool';

export default function DeployContractsPage() {
  const connected = useWalletConnected();
  const globalAccount = useSyncExternalStore(subscribeWalletAccount, getWalletAccount);
  const [account, setAccount] = useState<string | null>(globalAccount);
  const [balanceEth, setBalanceEth] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<DeploymentTarget>('router');
  const [status, setStatus] = useState<'idle' | 'preparing' | 'awaiting_signature' | 'confirming' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [deployedAddress, setDeployedAddress] = useState<string | null>(null);
  const [blockNumber, setBlockNumber] = useState<string | null>(null);
  const [gasUsed, setGasUsed] = useState<string | null>(null);
  const [codeLength, setCodeLength] = useState<number | null>(null);
  const [isCodeNonEmpty, setIsCodeNonEmpty] = useState<boolean | null>(null);

  // Query account & balance
  const refreshAccountData = async () => {
    const provider = getEvmProvider();
    if (!provider) return;
    try {
      const accounts = await provider.request({ method: 'eth_accounts' });
      const addr = accounts && accounts[0] ? accounts[0] : globalAccount;
      if (addr) {
        setAccount(addr);
        setWalletAccount(addr);
        const currentChainId = await provider.request({ method: 'eth_chainId' });
        setChainId(currentChainId);

        const balHex = await provider.request({
          method: 'eth_getBalance',
          params: [addr, 'latest'],
        });
        if (balHex) {
          const balBigInt = BigInt(balHex);
          const balEth = (Number(balBigInt) / 1e18).toFixed(6);
          setBalanceEth(balEth);
        }
      } else {
        setAccount(null);
        setBalanceEth(null);
      }
    } catch (err) {
      console.error('Error reading wallet state:', err);
    }
  };

  useEffect(() => {
    refreshAccountData();
    const provider = getEvmProvider();
    if (provider?.on) {
      const handleAccounts = () => refreshAccountData();
      const handleChain = () => refreshAccountData();
      provider.on('accountsChanged', handleAccounts);
      provider.on('chainChanged', handleChain);
      return () => {
        provider.removeListener?.('accountsChanged', handleAccounts);
        provider.removeListener?.('chainChanged', handleChain);
      };
    }
  }, [connected]);

  const deployData = selectedTarget === 'router'
    ? INCENTIFI_ROUTER_FULL_DEPLOY_DATA
    : selectedTarget === 'factory'
    ? INCENTIFI_FACTORY_FULL_DEPLOY_DATA
    : LOSS_REWARD_POOL_FULL_DEPLOY_DATA;

  const handleDeploy = async () => {
    setStatus('preparing');
    setErrorMessage(null);

    const provider = getEvmProvider();
    if (!provider) {
      setStatus('error');
      setErrorMessage('No EVM wallet found. Please install MetaMask, Rabby, or Robinhood Wallet.');
      return;
    }

    try {
      await ensureEvmChain();
      const currentAccount = await requestEvmAccounts();
      setAccount(currentAccount);

      // Verify balance
      const balHex = await provider.request({
        method: 'eth_getBalance',
        params: [currentAccount, 'latest'],
      });
      const bal = Number(BigInt(balHex || '0x0')) / 1e18;
      setBalanceEth(bal.toFixed(6));

      if (bal < 0.0005) {
        throw new Error(`Insufficient funds: Your wallet has ${bal.toFixed(6)} ETH. You need at least ~0.001 ETH to cover deployment gas on Robinhood Chain.`);
      }

      setStatus('awaiting_signature');

      // Request browser wallet signature
      const hash = await provider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: currentAccount,
            data: deployData,
          },
        ],
      });

      setTxHash(hash);
      setStatus('confirming');

      // Poll for receipt
      let receipt: any = null;
      for (let attempt = 0; attempt < 90; attempt++) {
        receipt = await provider.request({
          method: 'eth_getTransactionReceipt',
          params: [hash],
        });
        if (receipt?.contractAddress) break;
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (!receipt || !receipt.contractAddress) {
        throw new Error('Transaction was broadcast, but receipt confirmation timed out. Please check the explorer.');
      }

      const contractAddr = receipt.contractAddress;
      setDeployedAddress(contractAddr);
      setBlockNumber(receipt.blockNumber ? String(BigInt(receipt.blockNumber)) : 'Confirmed');
      setGasUsed(receipt.gasUsed ? String(BigInt(receipt.gasUsed)) : 'N/A');

      // Verify eth_getCode
      const code = await provider.request({
        method: 'eth_getCode',
        params: [contractAddr, 'latest'],
      });

      const nonEmpty = Boolean(code && code !== '0x' && code.length > 2);
      setIsCodeNonEmpty(nonEmpty);
      setCodeLength(code ? (code.length - 2) / 2 : 0);

      setStatus('success');
    } catch (err: any) {
      console.error('Deployment error:', err);
      setStatus('error');
      setErrorMessage(err?.message || 'Transaction was rejected or failed.');
    }
  };

  return (
    <div className="min-h-screen bg-[#061214] text-[#E9E1D8] font-sans antialiased pb-20">
      {/* Header */}
      <header className="border-b border-[#183033] bg-[#061214]/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-3">
            <span className="text-xl font-black tracking-tight text-white">INCENTIFI</span>
            <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded bg-[#183033] text-[#00E599]">
              Mainnet Deployer
            </span>
          </Link>
          <div className="flex items-center gap-4">
            <Link to="/" className="text-sm font-medium text-[#8EACB0] hover:text-white transition">
              Back to App
            </Link>
            <WalletButton />
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-4xl mx-auto px-4 pt-10">
        <div className="mb-8">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#102428] border border-[#183033] text-xs font-semibold text-[#00E599] mb-3">
            <span className="h-2 w-2 rounded-full bg-[#00E599] animate-pulse"></span>
            Robinhood Chain Mainnet (Chain ID 4663)
          </div>
          <h1 className="text-3xl font-extrabold text-white tracking-tight">Contract Deployment Console</h1>
          <p className="text-sm text-[#8EACB0] mt-1">
            Sign contract deployments directly using your connected browser wallet (MetaMask, Rabby, Robinhood Wallet).
          </p>
        </div>

        {/* Stage 1, 2 & 3 Verified Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
          {/* Stage 1: Verified LossRewardPool Status */}
          <div className="rounded-2xl border border-[#00E599]/30 bg-[#102428]/40 p-3.5 shadow-lg">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-6 w-6 rounded-full bg-[#00E599]/20 border border-[#00E599] flex items-center justify-center text-[#00E599] text-[10px] font-bold">
                  ✓
                </div>
                <div>
                  <div className="text-[10px] font-bold text-[#00E599] uppercase tracking-wider">
                    Stage 1: Pool
                  </div>
                  <div className="font-mono text-[10px] text-[#DDE8EA] mt-0.5 break-all">
                    {LOSS_REWARD_POOL.slice(0, 8)}...{LOSS_REWARD_POOL.slice(-6)}
                  </div>
                </div>
              </div>
              <a
                href={EVM_ADDRESS_URL(LOSS_REWARD_POOL)}
                target="_blank"
                rel="noreferrer"
                className="px-2 py-0.5 rounded bg-[#183033] hover:bg-[#224448] text-[#00E599] text-[10px] font-semibold transition whitespace-nowrap"
              >
                ↗
              </a>
            </div>
          </div>

          {/* Stage 2: Verified Factory Status */}
          <div className="rounded-2xl border border-[#00E599]/30 bg-[#102428]/40 p-3.5 shadow-lg">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-6 w-6 rounded-full bg-[#00E599]/20 border border-[#00E599] flex items-center justify-center text-[#00E599] text-[10px] font-bold">
                  ✓
                </div>
                <div>
                  <div className="text-[10px] font-bold text-[#00E599] uppercase tracking-wider">
                    Stage 2: Factory
                  </div>
                  <div className="font-mono text-[10px] text-[#DDE8EA] mt-0.5 break-all">
                    {INCENTIFI_BONDING_CURVE_FACTORY.slice(0, 8)}...{INCENTIFI_BONDING_CURVE_FACTORY.slice(-6)}
                  </div>
                </div>
              </div>
              <a
                href={EVM_ADDRESS_URL(INCENTIFI_BONDING_CURVE_FACTORY)}
                target="_blank"
                rel="noreferrer"
                className="px-2 py-0.5 rounded bg-[#183033] hover:bg-[#224448] text-[#00E599] text-[10px] font-semibold transition whitespace-nowrap"
              >
                ↗
              </a>
            </div>
          </div>

          {/* Stage 3: Verified Router Status */}
          <div className="rounded-2xl border border-[#00E599]/30 bg-[#102428]/40 p-3.5 shadow-lg">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-6 w-6 rounded-full bg-[#00E599]/20 border border-[#00E599] flex items-center justify-center text-[#00E599] text-[10px] font-bold">
                  ✓
                </div>
                <div>
                  <div className="text-[10px] font-bold text-[#00E599] uppercase tracking-wider">
                    Stage 3: Router
                  </div>
                  <div className="font-mono text-[10px] text-[#DDE8EA] mt-0.5 break-all">
                    {INCENTIFI_SWAP_ROUTER.slice(0, 8)}...{INCENTIFI_SWAP_ROUTER.slice(-6)}
                  </div>
                </div>
              </div>
              <a
                href={EVM_ADDRESS_URL(INCENTIFI_SWAP_ROUTER)}
                target="_blank"
                rel="noreferrer"
                className="px-2 py-0.5 rounded bg-[#183033] hover:bg-[#224448] text-[#00E599] text-[10px] font-semibold transition whitespace-nowrap"
              >
                ↗
              </a>
            </div>
          </div>
        </div>

        {/* Contract Selection Tabs */}
        <div className="flex gap-2 mb-6 border-b border-[#183033] pb-3">
          <button
            onClick={() => { setSelectedTarget('router'); setStatus('idle'); }}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
              selectedTarget === 'router'
                ? 'bg-[#00E599] text-[#061214]'
                : 'bg-[#0B171A] text-[#8EACB0] hover:text-white border border-[#183033]'
            }`}
          >
            Stage 3: IncentifiSwapRouter.sol (Active Target)
          </button>
          <button
            onClick={() => { setSelectedTarget('factory'); setStatus('idle'); }}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
              selectedTarget === 'factory'
                ? 'bg-[#00E599] text-[#061214]'
                : 'bg-[#0B171A] text-[#8EACB0] hover:text-white border border-[#183033]'
            }`}
          >
            Stage 2: Factory (Verified)
          </button>
          <button
            onClick={() => { setSelectedTarget('lossRewardPool'); setStatus('idle'); }}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
              selectedTarget === 'lossRewardPool'
                ? 'bg-[#00E599] text-[#061214]'
                : 'bg-[#0B171A] text-[#8EACB0] hover:text-white border border-[#183033]'
            }`}
          >
            Stage 1: LossRewardPool (Verified)
          </button>
        </div>

        {/* Contract Specs Card */}
        <div className="rounded-2xl border border-[#183033] bg-[#0B171A] p-6 mb-6 shadow-xl">
          <h2 className="text-base font-bold text-white mb-4 flex items-center gap-2">
            <svg className="w-5 h-5 text-[#00E599]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            {selectedTarget === 'router'
              ? 'IncentifiSwapRouter.sol Deployment Specifications'
              : selectedTarget === 'factory'
              ? 'IncentifiBondingCurveFactory.sol Deployment Specifications'
              : 'LossRewardPool.sol Deployment Specifications'}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="p-3.5 rounded-xl bg-[#061214] border border-[#183033]">
              <span className="text-[#8EACB0] block mb-1 font-medium">Target Contract</span>
              <span className="font-mono text-white font-semibold">
                {selectedTarget === 'router'
                  ? 'contracts/IncentifiSwapRouter.sol'
                  : selectedTarget === 'factory'
                  ? 'contracts/IncentifiBondingCurveFactory.sol'
                  : 'contracts/LossRewardPool.sol'}
              </span>
            </div>

            <div className="p-3.5 rounded-xl bg-[#061214] border border-[#183033]">
              <span className="text-[#8EACB0] block mb-1 font-medium">Target Network</span>
              <span className="font-mono text-white font-semibold">{EVM_CHAIN_NAME} (Chain ID: 4663)</span>
            </div>

            {selectedTarget === 'router' ? (
              <>
                <div className="p-3.5 rounded-xl bg-[#061214] border border-[#183033]">
                  <span className="text-[#8EACB0] block mb-1 font-medium">1. _uniswapRouter (Robinhood Uniswap V3)</span>
                  <span className="font-mono text-[#00E599] font-semibold break-all">{ROUTER_CONSTRUCTOR_PARAMS.uniswapRouter}</span>
                </div>

                <div className="p-3.5 rounded-xl bg-[#061214] border border-[#183033]">
                  <span className="text-[#8EACB0] block mb-1 font-medium">2. _weth (Canonical WETH)</span>
                  <span className="font-mono text-[#00E599] font-semibold break-all">{ROUTER_CONSTRUCTOR_PARAMS.weth}</span>
                </div>

                <div className="p-3.5 rounded-xl bg-[#061214] border border-[#183033]">
                  <span className="text-[#8EACB0] block mb-1 font-medium">3. _lossRewardPool (Verified Mainnet)</span>
                  <span className="font-mono text-[#00E599] font-semibold break-all">{ROUTER_CONSTRUCTOR_PARAMS.lossRewardPool}</span>
                </div>

                <div className="p-3.5 rounded-xl bg-[#061214] border border-[#183033]">
                  <span className="text-[#8EACB0] block mb-1 font-medium">4. _bondingCurveFactory (Verified Mainnet)</span>
                  <span className="font-mono text-[#00E599] font-semibold break-all">{ROUTER_CONSTRUCTOR_PARAMS.bondingCurveFactory}</span>
                </div>

                <div className="p-3.5 rounded-xl bg-[#061214] border border-[#183033] md:col-span-2">
                  <span className="text-[#8EACB0] block mb-1 font-medium">Estimated Gas Limit & Cost</span>
                  <span className="font-mono text-white font-semibold">~1,088,528 gas units (~0.00045 ETH @ ~0.35 Gwei)</span>
                </div>
              </>
            ) : selectedTarget === 'factory' ? (
              <>
                <div className="p-3.5 rounded-xl bg-[#061214] border border-[#183033]">
                  <span className="text-[#8EACB0] block mb-1 font-medium">1. _lossRewardPool</span>
                  <span className="font-mono text-[#00E599] font-semibold break-all">{FACTORY_CONSTRUCTOR_PARAMS.lossRewardPool}</span>
                </div>

                <div className="p-3.5 rounded-xl bg-[#061214] border border-[#183033]">
                  <span className="text-[#8EACB0] block mb-1 font-medium">2. _weth</span>
                  <span className="font-mono text-[#00E599] font-semibold break-all">{FACTORY_CONSTRUCTOR_PARAMS.weth}</span>
                </div>

                <div className="p-3.5 rounded-xl bg-[#061214] border border-[#183033]">
                  <span className="text-[#8EACB0] block mb-1 font-medium">3. _positionManager</span>
                  <span className="font-mono text-[#00E599] font-semibold break-all">{FACTORY_CONSTRUCTOR_PARAMS.positionManager}</span>
                </div>

                <div className="p-3.5 rounded-xl bg-[#061214] border border-[#183033]">
                  <span className="text-[#8EACB0] block mb-1 font-medium">4. _uniswapFactory</span>
                  <span className="font-mono text-[#00E599] font-semibold break-all">{FACTORY_CONSTRUCTOR_PARAMS.uniswapFactory}</span>
                </div>
              </>
            ) : (
              <div className="p-3.5 rounded-xl bg-[#061214] border border-[#183033] md:col-span-2">
                <span className="text-[#8EACB0] block mb-1 font-medium">Constructor Argument (_operator)</span>
                <span className="font-mono text-[#00E599] font-semibold break-all">address(0) [0x0000000000000000000000000000000000000000]</span>
              </div>
            )}

            <div className="p-3.5 rounded-xl bg-[#061214] border border-[#183033] md:col-span-2">
              <span className="text-[#8EACB0] block mb-1 font-medium">Deployer Wallet (from Browser)</span>
              <div className="flex items-center justify-between">
                <span className="font-mono text-white font-semibold break-all">
                  {account || 'Wallet not connected'}
                </span>
                {balanceEth && (
                  <span className="px-2 py-0.5 rounded bg-[#102428] text-[#00E599] font-mono text-xs font-semibold ml-2 whitespace-nowrap">
                    {balanceEth} ETH
                  </span>
                )}
              </div>
            </div>
          </div>

          {selectedTarget === 'router' && (
            <div className="mt-4 pt-4 border-t border-[#183033]">
              <details className="cursor-pointer text-xs text-[#8EACB0]">
                <summary className="font-medium hover:text-white transition">View Router Calldata Details</summary>
                <div className="mt-3 space-y-2">
                  <div>
                    <span className="text-[11px] text-[#8EACB0] block mb-0.5">Constructor Argument Hex (128 bytes):</span>
                    <div className="p-2 rounded bg-[#061214] border border-[#183033] font-mono text-[10px] text-[#00E599] break-all">
                      {INCENTIFI_ROUTER_CONSTRUCTOR_ARGS}
                    </div>
                  </div>
                  <div>
                    <span className="text-[11px] text-[#8EACB0] block mb-0.5">Creation Bytecode Size:</span>
                    <span className="text-white font-mono font-semibold">5,157 bytes</span>
                  </div>
                  <div>
                    <span className="text-[11px] text-[#8EACB0] block mb-0.5">Full Deployment Calldata Size:</span>
                    <span className="text-white font-mono font-semibold">5,285 bytes</span>
                  </div>
                </div>
              </details>
            </div>
          )}
        </div>

        {/* Action Panel */}
        <div className="rounded-2xl border border-[#183033] bg-[#0B171A] p-6 shadow-xl">
          {status === 'idle' && (
            <div className="text-center py-4">
              <p className="text-xs text-[#8EACB0] mb-5">
                Clicking below will open your browser wallet (MetaMask / Rabby) with the prepared contract creation transaction. You will manually review and sign in your wallet.
              </p>
              <button
                onClick={handleDeploy}
                className="px-8 py-3.5 rounded-xl bg-[#00E599] hover:bg-[#00c984] text-[#061214] font-bold text-sm transition transform hover:scale-[1.01] active:scale-[0.99] shadow-lg shadow-[#00E599]/20"
              >
                Sign & Deploy {selectedTarget === 'router' ? 'IncentifiSwapRouter' : selectedTarget === 'factory' ? 'IncentifiBondingCurveFactory' : 'LossRewardPool'} via Wallet
              </button>
            </div>
          )}

          {status === 'preparing' && (
            <div className="text-center py-6">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#00E599] mb-3"></div>
              <p className="text-sm font-semibold text-white">Preparing deployment parameters...</p>
              <p className="text-xs text-[#8EACB0] mt-1">Verifying chain connection and wallet balance.</p>
            </div>
          )}

          {status === 'awaiting_signature' && (
            <div className="text-center py-6">
              <div className="inline-block animate-pulse rounded-full h-10 w-10 bg-[#00E599]/20 border border-[#00E599] flex items-center justify-center mx-auto mb-3">
                <span className="text-xs font-bold text-[#00E599]">SIGN</span>
              </div>
              <p className="text-sm font-bold text-white">Please approve the transaction in your browser wallet...</p>
              <p className="text-xs text-[#8EACB0] mt-1">Check MetaMask / Rabby popup to confirm the contract creation.</p>
            </div>
          )}

          {status === 'confirming' && (
            <div className="text-center py-6">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#00E599] mb-3"></div>
              <p className="text-sm font-bold text-white">Broadcasting & Waiting for Confirmation...</p>
              {txHash && (
                <p className="text-xs font-mono text-[#8EACB0] mt-2 break-all">
                  Tx Hash: <a href={EVM_TX_URL(txHash)} target="_blank" rel="noreferrer" className="text-[#00E599] hover:underline">{txHash}</a>
                </p>
              )}
            </div>
          )}

          {status === 'success' && (
            <div className="py-2 space-y-4">
              <div className="p-4 rounded-xl bg-[#102428] border border-[#00E599]/40 text-[#00E599]">
                <div className="flex items-center gap-2 mb-1">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span className="font-bold text-sm">Deployment Confirmed & Verified on Mainnet!</span>
                </div>
                <p className="text-xs text-[#8EACB0]">
                  {selectedTarget === 'router'
                    ? 'IncentifiSwapRouter.sol'
                    : selectedTarget === 'factory'
                    ? 'IncentifiBondingCurveFactory.sol'
                    : 'LossRewardPool.sol'} is officially live on Robinhood Chain Mainnet.
                </p>
              </div>

              <div className="space-y-2.5 text-xs">
                <div className="p-3 rounded-xl bg-[#061214] border border-[#183033]">
                  <span className="text-[#8EACB0] block font-medium mb-0.5">NEW Contract Address:</span>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[#00E599] font-bold text-sm break-all">{deployedAddress}</span>
                    {deployedAddress && (
                      <a
                        href={EVM_ADDRESS_URL(deployedAddress)}
                        target="_blank"
                        rel="noreferrer"
                        className="px-2.5 py-1 rounded bg-[#183033] hover:bg-[#224448] text-white text-[11px] font-semibold transition ml-2 whitespace-nowrap"
                      >
                        View on Explorer ↗
                      </a>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                  <div className="p-3 rounded-xl bg-[#061214] border border-[#183033]">
                    <span className="text-[#8EACB0] block font-medium mb-0.5">Transaction Hash:</span>
                    {txHash && (
                      <a href={EVM_TX_URL(txHash)} target="_blank" rel="noreferrer" className="font-mono text-white hover:text-[#00E599] underline break-all">
                        {txHash}
                      </a>
                    )}
                  </div>

                  <div className="p-3 rounded-xl bg-[#061214] border border-[#183033]">
                    <span className="text-[#8EACB0] block font-medium mb-0.5">Block Number:</span>
                    <span className="font-mono text-white font-bold">{blockNumber}</span>
                  </div>

                  <div className="p-3 rounded-xl bg-[#061214] border border-[#183033]">
                    <span className="text-[#8EACB0] block font-medium mb-0.5">Deployer Address:</span>
                    <span className="font-mono text-white font-semibold break-all">{account}</span>
                  </div>

                  <div className="p-3 rounded-xl bg-[#061214] border border-[#183033]">
                    <span className="text-[#8EACB0] block font-medium mb-0.5">Gas Used:</span>
                    <span className="font-mono text-white font-bold">{gasUsed}</span>
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-[#061214] border border-[#183033]">
                  <span className="text-[#8EACB0] block font-medium mb-0.5">eth_getCode Verification:</span>
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded bg-[#102428] text-[#00E599] font-semibold text-[11px]">
                      {isCodeNonEmpty ? 'NON-EMPTY (VERIFIED)' : 'EMPTY (FAILED)'}
                    </span>
                    <span className="text-[#8EACB0] font-mono text-[11px]">
                      Deployed Runtime Code Length: {codeLength} bytes
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {status === 'error' && (
            <div className="py-2 space-y-4">
              <div className="p-4 rounded-xl bg-[#7A2730]/30 border border-[#7A2730] text-[#FFD7D7]">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-bold text-sm">Deployment Failed or Cancelled</span>
                </div>
                <p className="text-xs">{errorMessage}</p>
              </div>

              <div className="text-center">
                <button
                  onClick={handleDeploy}
                  className="px-6 py-2.5 rounded-xl bg-[#183033] hover:bg-[#224448] text-white font-semibold text-xs transition"
                >
                  Try Again
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
