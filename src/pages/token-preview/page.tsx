import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Copy,
  Check,
  ExternalLink,
  ShieldCheck,
  TrendingUp,
  RefreshCw,
  Send,
  Lock,
  Globe,
  MessageSquare,
  Activity,
  Layers,
  Coins,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import WalletButton from '../../components/WalletButton';
import { supabase } from '../../lib/supabase';
import {
  EVM_ADDRESS_URL,
  EVM_CHAIN_NAME,
  EVM_NATIVE_SYMBOL,
  EVM_TX_URL,
  getEvmProvider,
} from '../../lib/evmNetwork';
import {
  fetchIndexedCandles,
  fetchIndexerHeartbeat,
  fetchIndexedSnapshot,
  fetchIndexedTrades,
  fetchEvmSnapshot,
  fetchEvmTrades,
} from '../../lib/marketData';
import { buyToken, sellToken, getPoolMarketState } from '../../lib/swap';
import { fetchPoolHistory } from '../../lib/poolHistory';
import { fetchChatMessages, postChatMessage, type ChatMessage } from '../../lib/chat';
import { getWalletAccount } from '../../lib/walletAccount';
import { describeError } from '../../lib/errors';
import { encodeFunctionData, parseAbi, getAddress } from 'viem';
import {
  getHolderCostBasis,
  calculateUnrealizedLossStats,
  getClaimableRewards,
  claimBatchRewards,
  getLossRewardPoolTVL,
  type HolderCostBasis,
  type ClaimableRewardsState,
} from '../../lib/lossReward';
import IncentifiPriceChart, { type ChartPoint, type Trade, type TradeSide } from './IncentifiPriceChart';

type TokenData = {
  tokenName: string;
  tokenSymbol: string;
  description?: string;
  imageUrl?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  mintAddress?: string;
  chain?: 'evm';
};

type Position = {
  tokens: number;
  investedSol: number;
  avgEntry: number;
  realizedPnl: number;
};

type OnchainBalances = {
  walletSol: number;
  tokenBalance: number;
  loading: boolean;
};

type OnchainMintInfo = {
  decimals: number;
  symbol: string;
};

type FeedStatus = 'disconnected' | 'connecting' | 'live' | 'error';

type MarketSnapshot = {
  priceSol: number;
  liquiditySol: number;
  volume24hSol: number;
  marketCapUsd: number;
  fdvUsd: number;
  priceChange24hPct: number;
  updatedAt: number;
};

type LivePoolState = {
  priceEth: number;
  liquidityEth: number;
  updatedAt: number;
};

type TxPhase = 'idle' | 'signing' | 'sending' | 'confirming' | 'success' | 'error';

const TOTAL_SUPPLY = 1_000_000_000;
const FALLBACK_ETH_USD = 1840;

const formatNumber = (value: number, maxDecimals = 4): string => {
  if (!Number.isFinite(value)) return '0';
  if (value === 0) return '0';
  if (Math.abs(value) < 0.0001) return '<0.0001';
  return value.toLocaleString(undefined, { maximumFractionDigits: maxDecimals });
};

const formatPrice = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value < 0.000001) return value.toExponential(4);
  if (value < 0.0001) return value.toFixed(8);
  if (value < 1) return value.toFixed(6);
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
};

const formatEth = (value: number): string => {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  if (value < 0.000001) return '<0.000001';
  return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
};

const formatTokenAmount = (value: number, decimals = 6): string => {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toLocaleString(undefined, {
    maximumFractionDigits: Math.min(6, Math.max(2, decimals)),
  });
};

const formatCurrencyCompact = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value < 0.01) return '<$0.01';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value);
};

const formatPercent = (value: number, digits = 2): string => {
  if (!Number.isFinite(value)) return '0.00';
  return value.toFixed(digits);
};

const shortSig = (sig: string) => {
  if (!sig) return '';
  if (sig.length <= 12) return sig;
  return `${sig.slice(0, 6)}...${sig.slice(-6)}`;
};

const TokenPreviewPage = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [tokenData, setTokenData] = useState<TokenData | null>(null);
  const [activeTab, setActiveTab] = useState<TradeSide>('buy');
  const [buyAmountEth, setBuyAmountEth] = useState('0.1');
  const [sellAmountToken, setSellAmountToken] = useState('');
  const [onchainBusy, setOnchainBusy] = useState(false);
  const [onchainBalances, setOnchainBalances] = useState<OnchainBalances>({
    walletSol: 0,
    tokenBalance: 0,
    loading: false,
  });
  const [onchainMintInfo, setOnchainMintInfo] = useState<OnchainMintInfo>({
    decimals: 18,
    symbol: '',
  });
  const [slippage, setSlippage] = useState(1);
  const [status, setStatus] = useState('');
  const [txPhase, setTxPhase] = useState<TxPhase>('idle');
  const [feedStatus, setFeedStatus] = useState<FeedStatus>('disconnected');
  const [marketSnapshot, setMarketSnapshot] = useState<MarketSnapshot | null>(null);
  const [livePoolState, setLivePoolState] = useState<LivePoolState | null>(null);
  const [primaryPoolAddress, setPrimaryPoolAddress] = useState('');
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState('');
  const [contractCopied, setContractCopied] = useState(false);
  const [ethUsdPrice, setEthUsdPrice] = useState(FALLBACK_ETH_USD);
  const [position, setPosition] = useState<Position>({
    tokens: 0,
    investedSol: 0,
    avgEntry: 0,
    realizedPnl: 0,
  });
  const seenTradeSignaturesRef = useRef<Set<string>>(new Set());

  // Incentifi Loss-Reward state
  const [costBasisData, setCostBasisData] = useState<HolderCostBasis | null>(null);
  const [claimableState, setClaimableState] = useState<ClaimableRewardsState>({ unclaimedEpochs: [], totalClaimableEth: 0 });
  const [lossPoolTvl, setLossPoolTvl] = useState<number>(0);
  const [claiming, setClaiming] = useState(false);
  const [claimSuccessMsg, setClaimSuccessMsg] = useState<string | null>(null);

  // Fetch live ETH/USD price from Coinbase
  useEffect(() => {
    let cancelled = false;
    const loadEthPrice = async () => {
      try {
        const response = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
        const body = await response.json();
        const price = Number(body?.data?.amount);
        if (!cancelled && Number.isFinite(price) && price > 0) setEthUsdPrice(price);
      } catch (err) {
        console.error('Failed to load live ETH/USD price:', err);
      }
    };
    loadEthPrice();
    const timer = setInterval(loadEthPrice, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Fetch Loss-Reward Data
  useEffect(() => {
    let cancelled = false;
    const loadLossRewardData = async () => {
      const wallet = getWalletAccount();
      if (!tokenData?.mintAddress) return;

      try {
        const [tvl, costBasis, claimable] = await Promise.all([
          getLossRewardPoolTVL(tokenData.mintAddress),
          wallet ? getHolderCostBasis(tokenData.mintAddress, wallet) : null,
          wallet ? getClaimableRewards(tokenData.mintAddress, wallet) : { unclaimedEpochs: [], totalClaimableEth: 0 },
        ]);

        if (!cancelled) {
          setLossPoolTvl(tvl);
          if (costBasis) setCostBasisData(costBasis);
          setClaimableState(claimable);
        }
      } catch (err) {
        console.error('Failed to load loss-reward data:', err);
      }
    };

    loadLossRewardData();
    const interval = setInterval(loadLossRewardData, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [tokenData?.mintAddress, onchainBalances.tokenBalance]);

  const lossStats = useMemo(() => {
    const currentPrice = livePoolState ? livePoolState.priceEth : 0;
    return calculateUnrealizedLossStats(costBasisData, currentPrice);
  }, [costBasisData, livePoolState]);

  const handleClaimRewards = async () => {
    const wallet = getWalletAccount();
    if (!wallet || !tokenData?.mintAddress || claimableState.unclaimedEpochs.length === 0) return;

    try {
      setClaiming(true);
      setClaimSuccessMsg(null);
      await claimBatchRewards(tokenData.mintAddress, wallet, claimableState.unclaimedEpochs);
      setClaimSuccessMsg(`Claimed ${claimableState.totalClaimableEth.toFixed(4)} ETH!`);
      setClaimableState({ unclaimedEpochs: [], totalClaimableEth: 0 });
      await refreshOnchainBalances();
    } catch (err: any) {
      console.error('Claim failed:', err);
      setStatus(describeError(err));
    } finally {
      setClaiming(false);
    }
  };

  // Load Token Metadata
  useEffect(() => {
    const loadToken = async () => {
      const pathParts = location.pathname.split('/');
      const symbolFromUrl = pathParts[pathParts.length - 1].toUpperCase();

      const saved = localStorage.getItem('previewToken');
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as TokenData;
          if (parsed.tokenSymbol?.toUpperCase() === symbolFromUrl) {
            setTokenData(parsed);
            setLoading(false);
            return;
          }
        } catch {
          // Ignore parse error and proceed to DB query
        }
      }

      try {
        const { data, error } = await supabase
          .from('tokens')
          .select('*')
          .eq('symbol', symbolFromUrl)
          .limit(1);

        if (error) throw new Error(error.message);

        if (data && data.length > 0) {
          const first = data[0] as {
            name?: string;
            symbol?: string;
            description?: string;
            image_url?: string;
            website?: string;
            twitter?: string;
            telegram?: string;
            mint_address?: string;
          };
          setTokenData({
            tokenName: first.name || symbolFromUrl,
            tokenSymbol: first.symbol || symbolFromUrl,
            description: first.description || '',
            imageUrl: first.image_url || '',
            website: first.website || '',
            twitter: first.twitter || '',
            telegram: first.telegram || '',
            mintAddress: first.mint_address || '',
            chain: 'evm',
          });
          setLoading(false);
          return;
        }
      } catch (err) {
        console.error('Failed to load token data:', err);
      }

      navigate('/launch');
    };

    loadToken();
  }, [location.pathname, navigate]);

  // Reset state when token changes
  useEffect(() => {
    if (!tokenData) return;
    setMarketSnapshot(null);
    setLivePoolState(null);
    setPrimaryPoolAddress('');
    setChartData([]);
    setTrades([]);
    seenTradeSignaturesRef.current.clear();
    setPosition({
      tokens: 0,
      investedSol: 0,
      avgEntry: 0,
      realizedPnl: 0,
    });
  }, [tokenData]);

  // Derived market statistics
  const isPoolActive = Boolean(primaryPoolAddress && livePoolState && livePoolState.priceEth > 0);
  const currentPriceEth = livePoolState?.priceEth || marketSnapshot?.priceSol || 0;
  const currentPriceUsd = currentPriceEth > 0 ? currentPriceEth * ethUsdPrice : 0;
  const marketCapUsd = currentPriceEth > 0 ? currentPriceEth * TOTAL_SUPPLY * ethUsdPrice : 0;
  const liquidityEth = livePoolState?.liquidityEth || marketSnapshot?.liquiditySol || 0;
  const liquidityUsd = liquidityEth > 0 ? liquidityEth * ethUsdPrice : 0;

  const totalVolumeEth = useMemo(() => {
    if (marketSnapshot?.volume24hSol && marketSnapshot.volume24hSol > 0) {
      return marketSnapshot.volume24hSol;
    }
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return trades.filter((t) => t.timestamp >= dayAgo).reduce((sum, t) => sum + t.amountSol, 0);
  }, [marketSnapshot?.volume24hSol, trades]);

  const priceChange24hPct = useMemo(() => {
    if (marketSnapshot && Number.isFinite(marketSnapshot.priceChange24hPct)) {
      return marketSnapshot.priceChange24hPct;
    }
    if (chartData.length < 2) return undefined;
    const first = chartData[Math.max(0, chartData.length - 25)]?.close || chartData[0].close;
    const last = chartData[chartData.length - 1].close;
    if (!first || first <= 0) return undefined;
    return ((last - first) / first) * 100;
  }, [marketSnapshot, chartData]);

  const displaySymbol = onchainMintInfo.symbol || tokenData?.tokenSymbol || '';

  // Load Live Pool Market State directly from chain
  useEffect(() => {
    if (!tokenData?.mintAddress) return;
    let cancelled = false;

    const loadLivePoolState = async () => {
      try {
        const pool = await getPoolMarketState(tokenData.mintAddress!);
        if (cancelled) return;
        setPrimaryPoolAddress(pool.poolAddress);
        setLivePoolState({
          priceEth: pool.priceEth,
          liquidityEth: pool.liquidityEth,
          updatedAt: Date.now(),
        });
      } catch (err) {
        if (!cancelled) {
          setPrimaryPoolAddress('');
          setLivePoolState(null);
        }
      }
    };

    loadLivePoolState();
    const timer = setInterval(loadLivePoolState, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tokenData?.mintAddress]);

  // Load Chat Messages
  useEffect(() => {
    if (!tokenData?.tokenSymbol) return;
    let cancelled = false;

    const loadChat = async () => {
      try {
        const messages = await fetchChatMessages(tokenData.tokenSymbol);
        if (!cancelled) setChatMessages(messages);
      } catch (err) {
        console.error('Failed to load chat messages:', err);
      }
    };

    loadChat();
    const timer = setInterval(loadChat, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tokenData?.tokenSymbol]);

  const submitChatMessage = async () => {
    const trader = getWalletAccount();
    if (!trader) {
      setChatError('Connect wallet to chat.');
      return;
    }
    if (!chatInput.trim()) return;
    if (!tokenData?.tokenSymbol) return;

    try {
      setChatSending(true);
      setChatError('');
      await postChatMessage(tokenData.tokenSymbol, trader, chatInput);
      setChatInput('');
      const messages = await fetchChatMessages(tokenData.tokenSymbol);
      setChatMessages(messages);
    } catch (err) {
      console.error('Failed to post chat message:', err);
      setChatError(describeError(err));
    } finally {
      setChatSending(false);
    }
  };

  // Load Onchain Token and ETH Balances
  useEffect(() => {
    if (!tokenData?.mintAddress) return;
    const trader = getWalletAccount();
    const provider = getEvmProvider();
    if (!trader || !provider) return;

    let cancelled = false;
    const loadBalances = async () => {
      try {
        const balanceData = encodeFunctionData({
          abi: parseAbi(['function balanceOf(address account) view returns (uint256)']),
          functionName: 'balanceOf',
          args: [getAddress(trader)],
        });
        const [tokenBalanceHex, weiBalanceHex] = await Promise.all([
          provider.request({
            method: 'eth_call',
            params: [{ to: tokenData.mintAddress, data: balanceData }, 'latest'],
          }),
          provider.request({ method: 'eth_getBalance', params: [trader, 'latest'] }),
        ]);
        if (cancelled) return;
        const tokenBalance = Number(BigInt(tokenBalanceHex)) / 1e18;
        const walletSol = Number(BigInt(weiBalanceHex)) / 1e18;
        setOnchainBalances({ walletSol, tokenBalance, loading: false });
        setPosition((prev) => ({ ...prev, tokens: tokenBalance }));
      } catch (err) {
        console.error('Failed to load initial on-chain balances:', err);
      }
    };

    loadBalances();
    return () => {
      cancelled = true;
    };
  }, [tokenData?.mintAddress]);

  useEffect(() => {
    if (!tokenData) return;
    setOnchainMintInfo({
      decimals: 18,
      symbol: tokenData.tokenSymbol,
    });
  }, [tokenData]);

  const getInitials = (symbol: string) => symbol.slice(0, 3).toUpperCase();

  const appendConfirmedTradePoint = (nextPrice: number, volumeSol: number, tsMs: number) => {
    setChartData((prev) => {
      const lastClose = prev.length > 0 ? prev[prev.length - 1].close : nextPrice;
      const open = lastClose;
      const close = nextPrice;
      const high = Math.max(open, close) * 1.002;
      const low = Math.min(open, close) * 0.998;
      const point: ChartPoint = {
        time: new Date(tsMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestamp: tsMs,
        open,
        high,
        low,
        close,
        volume: Math.max(0, volumeSol),
        isUp: close >= open,
      };
      return [...prev.slice(-140), point];
    });
  };

  const pushTrade = (trade: Trade) => {
    setTrades((prev) => {
      if (trade.signature) {
        if (seenTradeSignaturesRef.current.has(trade.signature)) return prev;
        seenTradeSignaturesRef.current.add(trade.signature);
        if (seenTradeSignaturesRef.current.size > 700) {
          const recent = new Set(prev.slice(0, 120).map((t) => t.signature).filter(Boolean) as string[]);
          seenTradeSignaturesRef.current = recent;
        }
      }
      return [trade, ...prev.slice(0, 79)];
    });
  };

  const tokenInputStep = useMemo(() => {
    const decimals = Math.max(0, Math.min(9, onchainMintInfo.decimals));
    return decimals === 0 ? '1' : `0.${'0'.repeat(decimals - 1)}1`;
  }, [onchainMintInfo.decimals]);

  // Load Indexed Supabase Data
  useEffect(() => {
    if (!tokenData) return;
    let cancelled = false;

    const loadIndexedState = async () => {
      try {
        const symbol = tokenData.tokenSymbol.toUpperCase();
        const [indexedSnapshot, indexedCandles, indexedTrades, heartbeat, evmSnap, evmTrades] = await Promise.all([
          fetchIndexedSnapshot(symbol),
          fetchIndexedCandles(symbol, 140),
          fetchIndexedTrades(symbol, 120),
          fetchIndexerHeartbeat(symbol),
          tokenData.mintAddress ? fetchEvmSnapshot(tokenData.mintAddress) : null,
          tokenData.mintAddress ? fetchEvmTrades(tokenData.mintAddress, 80) : [],
        ]);

        if (cancelled) return;

        if (evmSnap) {
          setMarketSnapshot({
            priceSol: evmSnap.priceEth,
            liquiditySol: evmSnap.liquidityEth,
            volume24hSol: evmSnap.volume24hEth,
            marketCapUsd: evmSnap.marketCapUsd,
            fdvUsd: evmSnap.marketCapUsd,
            priceChange24hPct: evmSnap.priceChange24hPct,
            updatedAt: evmSnap.updatedAt,
          });
        } else if (indexedSnapshot) {
          setMarketSnapshot({
            priceSol: indexedSnapshot.priceSol,
            liquiditySol: indexedSnapshot.liquiditySol,
            volume24hSol: indexedSnapshot.volume24hSol,
            marketCapUsd: indexedSnapshot.marketCapUsd,
            fdvUsd: indexedSnapshot.fdvUsd,
            priceChange24hPct: indexedSnapshot.priceChange24hPct,
            updatedAt: indexedSnapshot.updatedAt,
          });
        }

        if (indexedCandles.length > 0) {
          setChartData((prev) => {
            const byMinute = new Map<number, ChartPoint>();
            for (const row of prev) {
              byMinute.set(Math.floor(row.timestamp / 60_000), row);
            }
            for (const row of indexedCandles) {
              const bucket = Math.floor(row.timestamp / 60_000);
              byMinute.set(bucket, {
                time: new Date(row.timestamp).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
                timestamp: row.timestamp,
                open: row.open,
                high: row.high,
                low: row.low,
                close: row.close,
                volume: row.volumeSol,
                isUp: row.close >= row.open,
              });
            }
            return [...byMinute.values()]
              .sort((a, b) => a.timestamp - b.timestamp)
              .slice(-160);
          });
        }

        const combinedTrades = [...(evmTrades || []).map((t) => ({
          id: t.txHash,
          time: new Date(t.blockTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          timestamp: t.blockTime,
          side: t.side,
          price: t.priceEth,
          amountToken: t.amountToken,
          amountSol: t.amountEth,
          feeSol: t.creatorFeeEth + t.lossPoolFeeEth,
          signature: t.txHash,
        })), ...(indexedTrades || []).map((t) => ({
          id: t.id,
          time: new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          timestamp: t.timestamp,
          side: t.side,
          price: t.priceSol,
          amountToken: t.amountToken,
          amountSol: t.amountSol,
          feeSol: t.feeSol,
          signature: t.signature,
        }))];

        if (combinedTrades.length > 0) {
          setTrades((prev) => {
            const existing = new Map<string, Trade>();
            for (const trade of prev) {
              existing.set(trade.id, trade);
              if (trade.signature) seenTradeSignaturesRef.current.add(trade.signature);
            }
            for (const trade of combinedTrades) {
              if (trade.signature && seenTradeSignaturesRef.current.has(trade.signature)) continue;
              if (trade.signature) seenTradeSignaturesRef.current.add(trade.signature);
              existing.set(trade.id, trade);
            }
            return [...existing.values()]
              .sort((a, b) => b.timestamp - a.timestamp)
              .slice(0, 120);
          });
        }
      } catch (err) {
        console.error('Failed to load indexed market state:', err);
      }
    };

    loadIndexedState();
    const timer = setInterval(loadIndexedState, 20_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tokenData]);

  // Load Onchain Uniswap V3 Pool Swap Event History
  useEffect(() => {
    if (!primaryPoolAddress || !tokenData?.mintAddress) {
      setFeedStatus('disconnected');
      return;
    }

    let cancelled = false;
    const loadPoolHistory = async () => {
      setFeedStatus('connecting');
      try {
        const { trades: poolTrades, candles } = await fetchPoolHistory(
          primaryPoolAddress,
          tokenData.mintAddress as string,
          onchainMintInfo.decimals || 18
        );
        if (cancelled) return;

        if (candles.length > 0) {
          setChartData(
            candles.map((c) => ({
              time: new Date(c.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              timestamp: c.timestamp,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
              isUp: c.close >= c.open,
            }))
          );
        }

        if (poolTrades.length > 0) {
          setTrades(
            poolTrades.map((t) => ({
              id: t.id,
              time: new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              timestamp: t.timestamp,
              side: t.side,
              price: t.priceEth,
              amountToken: t.tokenAmount,
              amountSol: t.ethAmount,
              feeSol: 0,
              signature: t.txHash,
            }))
          );
        }

        setFeedStatus('live');
      } catch (err) {
        console.error('Failed to load pool trade history:', err);
        if (!cancelled) setFeedStatus('error');
      }
    };

    loadPoolHistory();
    const timer = setInterval(loadPoolHistory, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [primaryPoolAddress, tokenData?.mintAddress, onchainMintInfo.decimals]);

  if (loading || !tokenData) {
    return (
      <div className="min-h-screen bg-[#070A12] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-full border-2 border-[#1D2940] border-t-[#36BCFF] animate-spin" />
          <p className="text-[#8DA3CD] text-sm">Loading token details...</p>
        </div>
      </div>
    );
  }

  const submitBuy = async () => {
    const trader = getWalletAccount();
    if (!trader) {
      setStatus('Connect wallet first.');
      return;
    }
    const ethIn = Number(buyAmountEth);
    if (!Number.isFinite(ethIn) || ethIn <= 0) {
      setStatus('Enter a valid ETH amount.');
      return;
    }
    if (!tokenData?.mintAddress) {
      setStatus('No contract address found for this token.');
      return;
    }
    try {
      setOnchainBusy(true);
      setTxPhase('signing');
      const result = await buyToken(tokenData.mintAddress, trader, ethIn, slippage);
      const timestamp = Date.now();
      if (result.trade.side !== 'buy') {
        throw new Error('Transaction confirmed, but the pool reported a sell instead of a buy.');
      }
      pushTrade({
        id: result.txHash,
        signature: result.txHash,
        time: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestamp,
        side: result.trade.side,
        price: result.trade.priceEth,
        amountToken: result.trade.amountToken,
        amountSol: result.trade.amountEth,
        feeSol: 0,
      });
      appendConfirmedTradePoint(result.trade.priceEth, result.trade.amountEth, timestamp);
      const pool = await getPoolMarketState(tokenData.mintAddress);
      setPrimaryPoolAddress(pool.poolAddress);
      setLivePoolState({ priceEth: pool.priceEth, liquidityEth: pool.liquidityEth, updatedAt: Date.now() });
      setTxPhase('success');
      setStatus(`Buy confirmed (${shortSig(result.txHash)}).`);
      await refreshOnchainBalances();
    } catch (err) {
      console.error('Buy failed:', err);
      setTxPhase('error');
      setStatus(describeError(err));
    } finally {
      setOnchainBusy(false);
    }
  };

  const submitSell = async () => {
    const trader = getWalletAccount();
    if (!trader) {
      setStatus('Connect wallet first.');
      return;
    }
    const amount = Number(sellAmountToken);
    if (!Number.isFinite(amount) || amount <= 0) {
      setStatus('Enter a valid token amount.');
      return;
    }
    if (!tokenData?.mintAddress) {
      setStatus('No contract address found for this token.');
      return;
    }
    try {
      setOnchainBusy(true);
      setTxPhase('signing');
      const result = await sellToken(
        tokenData.mintAddress,
        trader,
        amount,
        onchainMintInfo.decimals,
        slippage
      );
      const timestamp = Date.now();
      if (result.trade.side !== 'sell') {
        throw new Error('Transaction confirmed, but the pool reported a buy instead of a sell.');
      }
      pushTrade({
        id: result.txHash,
        signature: result.txHash,
        time: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestamp,
        side: result.trade.side,
        price: result.trade.priceEth,
        amountToken: result.trade.amountToken,
        amountSol: result.trade.amountEth,
        feeSol: 0,
      });
      appendConfirmedTradePoint(result.trade.priceEth, result.trade.amountEth, timestamp);
      const pool = await getPoolMarketState(tokenData.mintAddress);
      setPrimaryPoolAddress(pool.poolAddress);
      setLivePoolState({ priceEth: pool.priceEth, liquidityEth: pool.liquidityEth, updatedAt: Date.now() });
      setTxPhase('success');
      setStatus(`Sell confirmed (${shortSig(result.txHash)}).`);
      setSellAmountToken('');
      await refreshOnchainBalances();
    } catch (err) {
      console.error('Sell failed:', err);
      setTxPhase('error');
      setStatus(describeError(err));
    } finally {
      setOnchainBusy(false);
    }
  };

  const quickBuy = (amount: number) => setBuyAmountEth(String(amount));

  const refreshOnchainBalances = async () => {
    const trader = getWalletAccount();
    const provider = getEvmProvider();
    if (!trader || !provider || !tokenData?.mintAddress) return;

    try {
      setOnchainBalances((prev) => ({ ...prev, loading: true }));

      const balanceData = encodeFunctionData({
        abi: parseAbi(['function balanceOf(address account) view returns (uint256)']),
        functionName: 'balanceOf',
        args: [getAddress(trader)],
      });

      const [tokenBalanceHex, weiBalanceHex] = await Promise.all([
        provider.request({
          method: 'eth_call',
          params: [{ to: tokenData.mintAddress, data: balanceData }, 'latest'],
        }),
        provider.request({ method: 'eth_getBalance', params: [trader, 'latest'] }),
      ]);

      const tokenBalance = Number(BigInt(tokenBalanceHex)) / 10 ** onchainMintInfo.decimals;
      const walletSol = Number(BigInt(weiBalanceHex)) / 1e18;

      setOnchainBalances({ walletSol, tokenBalance, loading: false });
      setPosition((prev) => ({ ...prev, tokens: tokenBalance }));
    } catch (err) {
      console.error('Failed to refresh on-chain balances:', err);
      setOnchainBalances((prev) => ({ ...prev, loading: false }));
    }
  };

  const normalizeTokenInput = (raw: string) => {
    if (!raw) return '';
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0) return '';
    const decimals = Math.max(0, Math.min(9, onchainMintInfo.decimals));
    const fixed = num.toFixed(decimals);
    return decimals > 0 ? fixed.replace(/\.?0+$/, '') : String(Math.floor(num));
  };

  const formatInputAmount = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return '';
    const decimals = Math.max(0, Math.min(9, onchainMintInfo.decimals));
    return normalizeTokenInput(value.toFixed(decimals));
  };

  const quickSellPct = (pct: number) => {
    if (position.tokens <= 0) return;
    setSellAmountToken(formatInputAmount(position.tokens * (pct / 100)));
  };

  const setMaxSell = () => {
    if (position.tokens <= 0) return;
    setSellAmountToken(formatInputAmount(position.tokens));
  };

  const copyContractAddress = () => {
    if (!tokenData?.mintAddress) return;
    navigator.clipboard.writeText(tokenData.mintAddress);
    setContractCopied(true);
    setTimeout(() => setContractCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-[#070A12] text-[#E8EEF9]">
      {/* Top Navbar */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-[#0B1120]/95 backdrop-blur border-b border-[#1D2940]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="h-16 sm:h-20 flex items-center justify-between">
            <Link to="/" className="flex items-center gap-3 group">
              <img
                src="/incentifi-logo.jpeg"
                alt="incentifi"
                className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg object-cover group-hover:scale-105 transition-transform"
              />
              <span className="brand-type text-[#E8EEF9] font-semibold text-lg sm:text-xl tracking-tight">
                incentifi
              </span>
            </Link>

            <div className="flex items-center gap-3">
              <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#10192C] border border-[#1D2940] text-xs text-[#8DA3CD]">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>{EVM_CHAIN_NAME}</span>
              </div>
              <WalletButton />
            </div>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="pt-20 sm:pt-24 pb-16">
        {/* Navigation Breadcrumb */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4">
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-xs sm:text-sm text-[#8DA3CD] hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Markets
          </Link>
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 space-y-6">
          {/* REDESIGNED TOKEN HEADER */}
          <div className="p-5 sm:p-7 rounded-2xl bg-[#0B1120] border border-[#1D2940] shadow-xl shadow-black/20">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
              {/* Left: Token Identity & Badges */}
              <div className="flex items-start sm:items-center gap-4 sm:gap-5">
                {tokenData.imageUrl ? (
                  <img
                    src={tokenData.imageUrl}
                    alt={tokenData.tokenName}
                    className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl object-cover border border-[#23385D] shadow-md flex-shrink-0"
                  />
                ) : (
                  <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-gradient-to-br from-[#00C2FF] to-[#0077B6] flex items-center justify-center text-white text-xl font-bold flex-shrink-0 shadow-md">
                    {getInitials(tokenData.tokenSymbol)}
                  </div>
                )}

                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h1 className="text-xl sm:text-2xl lg:text-3xl font-bold text-white tracking-tight">
                      {tokenData.tokenName}
                    </h1>
                    <span className="text-sm sm:text-base font-semibold px-2.5 py-0.5 rounded-lg bg-[#10192C] text-[#53B8FF] border border-[#1D2940]">
                      ${displaySymbol}
                    </span>
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-medium">
                      <ShieldCheck className="w-3.5 h-3.5" />
                      Robinhood Chain
                    </span>
                  </div>

                  {/* Contract Address & Action Links */}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {tokenData.mintAddress && (
                      <button
                        onClick={copyContractAddress}
                        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition border ${
                          contractCopied
                            ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                            : 'bg-[#10192C] border-[#1D2940] text-[#8DA3CD] hover:text-white hover:border-[#2A3D66]'
                        }`}
                        title="Click to copy contract address"
                      >
                        {contractCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{shortSig(tokenData.mintAddress)}</span>
                        <span className="text-[10px] text-[#64799E]">{contractCopied ? 'Copied' : 'Copy'}</span>
                      </button>
                    )}

                    {tokenData.mintAddress && (
                      <a
                        href={EVM_ADDRESS_URL(tokenData.mintAddress)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-[#10192C] border border-[#1D2940] text-xs font-medium text-[#8DA3CD] hover:text-white hover:border-[#2A3D66] transition"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        Explorer
                      </a>
                    )}

                    {tokenData.website && (
                      <a
                        href={tokenData.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-[#10192C] border border-[#1D2940] text-xs font-medium text-[#8DA3CD] hover:text-white hover:border-[#2A3D66] transition"
                      >
                        <Globe className="w-3.5 h-3.5" />
                        Website
                      </a>
                    )}

                    {primaryPoolAddress && (
                      <a
                        href={EVM_ADDRESS_URL(primaryPoolAddress)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-[#10192C] border border-[#1D2940] text-xs font-medium text-[#53B8FF] hover:text-white hover:border-[#2A3D66] transition"
                      >
                        <Layers className="w-3.5 h-3.5" />
                        Pool Contract
                      </a>
                    )}
                  </div>
                </div>
              </div>

              {/* Right: Real Compact Statistics Row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-left">
                {/* Price */}
                <div className="bg-[#10192C] border border-[#1D2940] rounded-xl p-3.5">
                  <span className="text-[11px] font-medium text-[#7D92BC] uppercase tracking-wider block mb-1">
                    Price
                  </span>
                  <p className="text-white font-bold text-base sm:text-lg tracking-tight">
                    {currentPriceEth > 0 ? (
                      <span>{formatPrice(currentPriceEth)} <span className="text-xs font-normal text-[#8DA3CD]">{EVM_NATIVE_SYMBOL}</span></span>
                    ) : (
                      <span className="text-[#8DA3CD] font-medium">—</span>
                    )}
                  </p>
                  <p className="text-[11px] text-[#64799E] mt-0.5">
                    {currentPriceUsd > 0 ? formatCurrencyCompact(currentPriceUsd) : 'Not available'}
                  </p>
                </div>

                {/* Market Cap */}
                <div className="bg-[#10192C] border border-[#1D2940] rounded-xl p-3.5">
                  <span className="text-[11px] font-medium text-[#7D92BC] uppercase tracking-wider block mb-1">
                    Market Cap
                  </span>
                  <p className="text-white font-bold text-base sm:text-lg tracking-tight">
                    {marketCapUsd > 0 ? (
                      formatCurrencyCompact(marketCapUsd)
                    ) : (
                      <span className="text-[#8DA3CD] font-medium">Awaiting pool</span>
                    )}
                  </p>
                  <p className="text-[11px] text-[#64799E] mt-0.5">
                    {marketCapUsd > 0 ? '1.00B Supply' : 'No active pool'}
                  </p>
                </div>

                {/* Liquidity */}
                <div className="bg-[#10192C] border border-[#1D2940] rounded-xl p-3.5">
                  <span className="text-[11px] font-medium text-[#7D92BC] uppercase tracking-wider block mb-1">
                    Liquidity
                  </span>
                  <p className="text-white font-bold text-base sm:text-lg tracking-tight">
                    {liquidityEth > 0 ? (
                      <span>{formatEth(liquidityEth)} <span className="text-xs font-normal text-[#8DA3CD]">{EVM_NATIVE_SYMBOL}</span></span>
                    ) : (
                      <span className="text-[#8DA3CD] font-medium">—</span>
                    )}
                  </p>
                  <p className="text-[11px] text-[#64799E] mt-0.5">
                    {liquidityUsd > 0 ? formatCurrencyCompact(liquidityUsd) : 'Awaiting liquidity'}
                  </p>
                </div>

                {/* 24h Volume & Change */}
                <div className="bg-[#10192C] border border-[#1D2940] rounded-xl p-3.5">
                  <span className="text-[11px] font-medium text-[#7D92BC] uppercase tracking-wider block mb-1">
                    24h Volume
                  </span>
                  <p className="text-white font-bold text-base sm:text-lg tracking-tight">
                    {totalVolumeEth > 0 ? (
                      <span>{formatEth(totalVolumeEth)} <span className="text-xs font-normal text-[#8DA3CD]">{EVM_NATIVE_SYMBOL}</span></span>
                    ) : (
                      <span className="text-[#8DA3CD] font-medium">0 ETH</span>
                    )}
                  </p>
                  <p className="text-[11px] mt-0.5">
                    {typeof priceChange24hPct === 'number' ? (
                      <span className={priceChange24hPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                        {priceChange24hPct >= 0 ? '+' : ''}{formatPercent(priceChange24hPct, 2)}% 24h
                      </span>
                    ) : (
                      <span className="text-[#64799E]">—</span>
                    )}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* MAIN 2-COLUMN GRID (Left: Chart, Description, Trades, Chat; Right: Trade, Position, Loss Reward, Contract) */}
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-6 items-start">
            {/* LEFT COLUMN */}
            <div className="space-y-6">
              {/* NATIVE INCENTIFI PRICE CHART */}
              <IncentifiPriceChart
                data={chartData}
                trades={trades}
                symbol={displaySymbol}
                currentPriceEth={currentPriceEth}
                ethUsdPrice={ethUsdPrice}
                priceChange24hPct={priceChange24hPct}
                loading={loading}
                isPoolActive={isPoolActive}
              />

              {/* TOKEN ABOUT / DESCRIPTION (if provided) */}
              {tokenData.description && (
                <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-5 sm:p-6">
                  <h3 className="text-base font-semibold text-white mb-2">About {tokenData.tokenName}</h3>
                  <p className="text-sm text-[#8DA3CD] leading-relaxed break-words whitespace-pre-wrap">
                    {tokenData.description}
                  </p>
                </div>
              )}

              {/* RECENT TRADES */}
              <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-5 sm:p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Activity className="w-5 h-5 text-[#36BCFF]" />
                    <h3 className="text-[#E8EEF9] font-semibold text-base">Recent Trades</h3>
                  </div>
                  {trades.length > 0 && (
                    <span className="text-xs text-[#8DA3CD] bg-[#10192C] px-2.5 py-1 rounded-full border border-[#1D2940]">
                      {trades.length} {trades.length === 1 ? 'trade' : 'trades'}
                    </span>
                  )}
                </div>

                {trades.length === 0 ? (
                  <div className="py-10 flex flex-col items-center justify-center text-center">
                    <div className="w-12 h-12 rounded-xl bg-[#10192C] border border-[#1D2940] flex items-center justify-center mb-3 text-[#64799E]">
                      <Activity className="w-6 h-6" />
                    </div>
                    <h4 className="text-sm font-semibold text-white mb-1">No trades yet</h4>
                    <p className="text-xs text-[#8DA3CD] max-w-sm">
                      The first transaction will appear here once trading begins through the Incentifi Router.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-[#7D92BC] border-b border-[#16243F] text-xs">
                          <th className="py-2.5 pr-3">Time</th>
                          <th className="py-2.5 pr-3">Side</th>
                          <th className="py-2.5 pr-3">Price ({EVM_NATIVE_SYMBOL})</th>
                          <th className="py-2.5 pr-3">Amount ({displaySymbol})</th>
                          <th className="py-2.5 pr-3">Total ({EVM_NATIVE_SYMBOL})</th>
                          <th className="py-2.5 pr-3">Tx</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#121C31]">
                        {trades.map((trade) => (
                          <tr key={trade.id} className="text-xs text-[#D4E1F7] hover:bg-[#10192C]/50 transition">
                            <td className="py-2.5 pr-3 text-[#8DA3CD] whitespace-nowrap">{trade.time}</td>
                            <td className="py-2.5 pr-3">
                              <span
                                className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                                  trade.side === 'buy'
                                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                    : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                                }`}
                              >
                                {trade.side.toUpperCase()}
                              </span>
                            </td>
                            <td className="py-2.5 pr-3 font-mono">{formatPrice(trade.price)}</td>
                            <td className="py-2.5 pr-3 font-mono">{formatTokenAmount(trade.amountToken, 4)}</td>
                            <td className="py-2.5 pr-3 font-mono">{formatEth(trade.amountSol)}</td>
                            <td className="py-2.5 pr-3">
                              {trade.signature ? (
                                <a
                                  href={EVM_TX_URL(trade.signature)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-[#36BCFF] hover:underline font-mono"
                                >
                                  {shortSig(trade.signature)}
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              ) : (
                                <span className="text-[#6079A6]">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* COMMUNITY CHAT */}
              <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-5 sm:p-6">
                <div className="flex items-center gap-2 mb-1">
                  <MessageSquare className="w-5 h-5 text-[#36BCFF]" />
                  <h3 className="text-[#E8EEF9] font-semibold text-base">Community Chat</h3>
                </div>
                <p className="text-xs text-[#7D92BC] mb-4">Connect wallet to join discussion.</p>

                <div className="max-h-72 overflow-y-auto space-y-3 pr-1 scrollbar-stealth">
                  {chatMessages.length === 0 ? (
                    <div className="py-8 text-center text-xs text-[#8DA3CD]">
                      No messages yet. Be the first to say something!
                    </div>
                  ) : (
                    chatMessages.map((msg) => (
                      <div key={msg.id} className="text-xs bg-[#10192C] border border-[#1D2940] rounded-xl p-3">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[#36BCFF] font-medium font-mono">
                            {shortSig(msg.walletAddress)}
                          </span>
                          <span className="text-[#64799E] text-[10px]">
                            {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        <p className="text-[#D4E1F7] break-words leading-relaxed">{msg.message}</p>
                      </div>
                    ))
                  )}
                </div>

                <div className="mt-4 flex gap-2">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitChatMessage();
                    }}
                    maxLength={500}
                    placeholder="Say something to the community..."
                    className="flex-1 px-4 py-2.5 rounded-xl bg-[#081122] border border-[#1D2940] text-[#E8EEF9] placeholder-[#5F6A6E] focus:outline-none focus:border-[#36BCFF] text-xs sm:text-sm"
                  />
                  <button
                    onClick={submitChatMessage}
                    disabled={chatSending || !chatInput.trim()}
                    className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-white text-xs sm:text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-1.5"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Send</span>
                  </button>
                </div>
                {chatError && <p className="text-xs text-rose-400 mt-2">{chatError}</p>}
              </div>
            </div>

            {/* RIGHT SIDEBAR (Sticky on desktop) */}
            <aside className="lg:sticky lg:top-24 space-y-5">
              {/* TRADING PANEL */}
              <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-5 shadow-xl shadow-black/20">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-white font-semibold text-base flex items-center gap-2">
                    <Coins className="w-4 h-4 text-[#36BCFF]" />
                    Trade ${displaySymbol}
                  </h3>
                  <span className="text-[11px] text-[#8DA3CD] bg-[#10192C] px-2 py-0.5 rounded border border-[#1D2940]">
                    1% Router Fee
                  </span>
                </div>

                {/* Buy / Sell Tab Switcher */}
                <div className="grid grid-cols-2 bg-[#070A12] p-1 rounded-xl mb-4 border border-[#1D2940]">
                  <button
                    onClick={() => setActiveTab('buy')}
                    className={`py-2 rounded-lg text-xs sm:text-sm font-semibold transition ${
                      activeTab === 'buy'
                        ? 'bg-emerald-500 text-white shadow-md shadow-emerald-500/20'
                        : 'text-[#7D92BC] hover:text-white'
                    }`}
                  >
                    Buy
                  </button>
                  <button
                    onClick={() => setActiveTab('sell')}
                    className={`py-2 rounded-lg text-xs sm:text-sm font-semibold transition ${
                      activeTab === 'sell'
                        ? 'bg-rose-500 text-white shadow-md shadow-rose-500/20'
                        : 'text-[#7D92BC] hover:text-white'
                    }`}
                  >
                    Sell
                  </button>
                </div>

                {activeTab === 'buy' ? (
                  <div className="space-y-4">
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="text-xs text-[#8DA3CD] font-medium">You Pay ({EVM_NATIVE_SYMBOL})</label>
                        <span className="text-[11px] text-[#64799E]">
                          Balance: {formatEth(onchainBalances.walletSol)} {EVM_NATIVE_SYMBOL}
                        </span>
                      </div>
                      <div className="relative">
                        <input
                          type="number"
                          min="0"
                          step="0.001"
                          value={buyAmountEth}
                          onChange={(e) => setBuyAmountEth(e.target.value)}
                          placeholder="0.0"
                          className="w-full px-4 py-3 rounded-xl bg-[#081122] border border-[#1D2940] text-[#E8EEF9] placeholder-[#5F6A6E] focus:outline-none focus:border-[#36BCFF] text-sm font-mono font-medium"
                        />
                        <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs font-semibold text-[#8DA3CD]">
                          {EVM_NATIVE_SYMBOL}
                        </span>
                      </div>
                    </div>

                    {/* Quick presets for Buy */}
                    <div className="grid grid-cols-4 gap-2">
                      {[0.01, 0.05, 0.1, 0.5].map((value) => (
                        <button
                          key={value}
                          onClick={() => quickBuy(value)}
                          className="py-1.5 rounded-lg bg-[#10192C] border border-[#1D2940] text-xs font-medium text-[#A9BCDE] hover:text-white hover:border-[#2A3D66] transition"
                        >
                          {value}
                        </button>
                      ))}
                    </div>

                    {/* Router Fee Breakdown Note */}
                    <div className="bg-[#070A12] border border-[#1D2940] rounded-xl p-3 text-[11px] text-[#8DA3CD] space-y-1">
                      <div className="flex items-center justify-between">
                        <span>Router Execution</span>
                        <span className="text-white font-medium">IncentifiSwapRouter</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Fee Allocation</span>
                        <span className="text-[#53B8FF]">0.5% Creator / 0.5% Loss Pool</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Slippage Tolerance</span>
                        <span className="text-white font-medium">{slippage}%</span>
                      </div>
                    </div>

                    <button
                      onClick={submitBuy}
                      disabled={onchainBusy || !isPoolActive}
                      className="w-full py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-white font-semibold text-sm shadow-lg shadow-emerald-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition"
                    >
                      {onchainBusy
                        ? txPhase === 'signing'
                          ? 'Awaiting wallet signature...'
                          : txPhase === 'sending'
                            ? 'Sending transaction...'
                            : txPhase === 'confirming'
                              ? 'Confirming on-chain...'
                              : 'Processing...'
                        : !isPoolActive
                          ? 'Awaiting Liquidity Pool'
                          : `Buy ${displaySymbol}`}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="text-xs text-[#8DA3CD] font-medium">You Sell ({displaySymbol})</label>
                        <span className="text-[11px] text-[#64799E]">
                          Balance: {formatTokenAmount(position.tokens, 2)} {displaySymbol}
                        </span>
                      </div>
                      <div className="flex gap-2">
                        <input
                          type="number"
                          min="0"
                          step={tokenInputStep}
                          value={sellAmountToken}
                          onChange={(e) => setSellAmountToken(normalizeTokenInput(e.target.value))}
                          placeholder="0.0"
                          className="flex-1 px-4 py-3 rounded-xl bg-[#081122] border border-[#1D2940] text-[#E8EEF9] placeholder-[#5F6A6E] focus:outline-none focus:border-[#36BCFF] text-sm font-mono font-medium"
                        />
                        <button
                          onClick={setMaxSell}
                          className="px-3.5 py-3 rounded-xl bg-[#13213D] border border-[#1D2940] text-[#C7D8F4] text-xs font-semibold hover:text-white hover:bg-[#1C325B] transition"
                        >
                          MAX
                        </button>
                      </div>
                    </div>

                    {/* Quick percentage buttons for Sell */}
                    <div className="grid grid-cols-4 gap-2">
                      {[25, 50, 75, 100].map((value) => (
                        <button
                          key={value}
                          onClick={() => quickSellPct(value)}
                          className="py-1.5 rounded-lg bg-[#10192C] border border-[#1D2940] text-xs font-medium text-[#A9BCDE] hover:text-white hover:border-[#2A3D66] transition"
                        >
                          {value}%
                        </button>
                      ))}
                    </div>

                    {/* Router Fee Breakdown Note */}
                    <div className="bg-[#070A12] border border-[#1D2940] rounded-xl p-3 text-[11px] text-[#8DA3CD] space-y-1">
                      <div className="flex items-center justify-between">
                        <span>Router Execution</span>
                        <span className="text-white font-medium">IncentifiSwapRouter</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Fee Allocation</span>
                        <span className="text-[#53B8FF]">0.5% Creator / 0.5% Loss Pool</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Slippage Tolerance</span>
                        <span className="text-white font-medium">{slippage}%</span>
                      </div>
                    </div>

                    <button
                      onClick={submitSell}
                      disabled={
                        onchainBusy ||
                        !isPoolActive ||
                        position.tokens <= 0 ||
                        !(Number(sellAmountToken) > 0 && Number(sellAmountToken) <= position.tokens)
                      }
                      className="w-full py-3 rounded-xl bg-rose-500 hover:bg-rose-400 text-white font-semibold text-sm shadow-lg shadow-rose-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition"
                    >
                      {onchainBusy
                        ? txPhase === 'signing'
                          ? 'Awaiting wallet signature...'
                          : txPhase === 'sending'
                            ? 'Sending transaction...'
                            : txPhase === 'confirming'
                              ? 'Confirming on-chain...'
                              : 'Processing...'
                        : !isPoolActive
                          ? 'Awaiting Liquidity Pool'
                          : position.tokens <= 0
                            ? 'No Tokens to Sell'
                            : `Sell ${displaySymbol}`}
                    </button>
                  </div>
                )}

                {/* Slippage Tolerance Input */}
                <div className="mt-4 pt-3 border-t border-[#16243F] flex items-center justify-between">
                  <label className="text-xs text-[#8DA3CD]">Slippage Tolerance</label>
                  <div className="flex items-center gap-1.5 w-24">
                    <input
                      type="number"
                      min="0.1"
                      max="100"
                      step="0.1"
                      value={slippage}
                      onChange={(e) => setSlippage(Math.min(100, Math.max(0.1, Number(e.target.value))))}
                      className="w-full px-2 py-1 rounded-lg bg-[#070A12] border border-[#1D2940] text-xs text-right text-white focus:outline-none focus:border-[#36BCFF]"
                    />
                    <span className="text-xs text-[#8DA3CD]">%</span>
                  </div>
                </div>

                {status && (
                  <div className="mt-3 p-2.5 rounded-xl bg-[#10192C] border border-[#1D2940] text-xs text-[#9ED0FF]">
                    {status}
                  </div>
                )}
              </div>

              {/* YOUR WALLET POSITION */}
              <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-5 shadow-xl shadow-black/20">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-white font-semibold text-sm">Your Position</h3>
                  <button
                    onClick={refreshOnchainBalances}
                    disabled={onchainBalances.loading}
                    className="text-xs text-[#36BCFF] hover:text-white transition flex items-center gap-1"
                    title="Refresh on-chain balances"
                  >
                    <RefreshCw className={`w-3 h-3 ${onchainBalances.loading ? 'animate-spin' : ''}`} />
                    <span>Sync</span>
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2.5 text-xs">
                  <div className="rounded-xl border border-[#1D2940] bg-[#070A12] p-3">
                    <span className="text-[#64799E] block mb-1">Native {EVM_NATIVE_SYMBOL}</span>
                    <span className="text-white font-bold text-sm block">
                      {formatEth(onchainBalances.walletSol)}
                    </span>
                    <span className="text-[10px] text-[#64799E]">
                      ≈ {formatCurrencyCompact(onchainBalances.walletSol * ethUsdPrice)}
                    </span>
                  </div>

                  <div className="rounded-xl border border-[#1D2940] bg-[#070A12] p-3">
                    <span className="text-[#64799E] block mb-1">${displaySymbol} Balance</span>
                    <span className="text-white font-bold text-sm block">
                      {formatTokenAmount(position.tokens, 2)}
                    </span>
                    <span className="text-[10px] text-[#64799E]">
                      ≈ {currentPriceUsd > 0 ? formatCurrencyCompact(position.tokens * currentPriceUsd) : '—'}
                    </span>
                  </div>
                </div>
              </div>

              {/* INCENTIFI LOSS-REWARD PROTECTION PANEL */}
              <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-5 shadow-xl shadow-black/20 relative overflow-hidden">
                <div className="flex items-center justify-between mb-3.5">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                    <h3 className="text-white font-semibold text-sm">Loss-Reward Protection</h3>
                  </div>
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-[#14B8A6]/10 text-[#53B8FF] border border-[#14B8A6]/30 uppercase tracking-wider">
                    10% Hourly
                  </span>
                </div>

                <div className="space-y-3 text-xs">
                  {/* Loss Pool TVL */}
                  <div className="flex items-center justify-between rounded-xl bg-[#070A12] px-3.5 py-2.5 border border-[#1D2940]">
                    <span className="text-[#8DA3CD]">Loss Pool Balance</span>
                    <span className="text-white font-bold text-sm">
                      {lossPoolTvl > 0 ? `${lossPoolTvl.toFixed(4)} ${EVM_NATIVE_SYMBOL}` : '0.0000 ETH'}
                    </span>
                  </div>

                  {/* Cost Basis vs Current Price */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-xl bg-[#070A12] p-2.5 border border-[#1D2940]">
                      <span className="text-[#64799E] block text-[10px] uppercase font-medium">Your Cost Basis</span>
                      <span className="text-white font-semibold text-xs mt-0.5 block">
                        {lossStats.costBasisEth > 0 ? `${lossStats.costBasisEth.toFixed(6)} ETH` : 'No Entry Yet'}
                      </span>
                    </div>
                    <div className="rounded-xl bg-[#070A12] p-2.5 border border-[#1D2940]">
                      <span className="text-[#64799E] block text-[10px] uppercase font-medium">Current Price</span>
                      <span className="text-white font-semibold text-xs mt-0.5 block">
                        {lossStats.currentPriceEth > 0 ? `${lossStats.currentPriceEth.toFixed(6)} ETH` : '0.000000 ETH'}
                      </span>
                    </div>
                  </div>

                  {/* Position Eligibility & Status */}
                  <div className="rounded-xl bg-[#070A12] p-3 border border-[#1D2940] space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[#8DA3CD]">Protection Status</span>
                      {costBasisData?.isUnderwaterSeller ? (
                        <span className="px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 font-semibold text-[10px] border border-rose-500/20">
                          Disqualified (Sold at Loss)
                        </span>
                      ) : lossStats.isUnderwater ? (
                        <span className="px-2 py-0.5 rounded bg-amber-500/10 text-amber-300 font-semibold text-[10px] border border-amber-500/20">
                          Underwater (-{lossStats.unrealizedLossPct.toFixed(1)}%)
                        </span>
                      ) : lossStats.tokenBalance > 0 ? (
                        <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-semibold text-[10px] border border-emerald-500/20">
                          In Profit / Breakeven
                        </span>
                      ) : (
                        <span className="text-[#64799E] text-[11px]">No Active Tokens</span>
                      )}
                    </div>

                    {lossStats.isUnderwater && (
                      <div className="pt-2 border-t border-[#16243F] flex items-center justify-between text-[11px]">
                        <span className="text-[#8DA3CD]">Unrealized Loss:</span>
                        <span className="text-rose-400 font-semibold">{lossStats.unrealizedLossEth.toFixed(5)} ETH</span>
                      </div>
                    )}

                    {lossStats.isUnderwater && lossStats.isEligible && (
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-[#8DA3CD]">Est. Hourly Reward:</span>
                        <span className="text-emerald-400 font-semibold">
                          {lossStats.theoreticalRewardEth.toFixed(5)} ETH (10%)
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Claim Reward Action */}
                  <div className="rounded-xl bg-gradient-to-br from-[#0C1A30] to-[#0A1424] p-3.5 border border-[#23385D] space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[#9FB0CF] text-xs">Claimable Rewards:</span>
                      <span className="text-white font-bold text-sm">
                        {claimableState.totalClaimableEth > 0 ? `${claimableState.totalClaimableEth.toFixed(5)} ${EVM_NATIVE_SYMBOL}` : '0.0000 ETH'}
                      </span>
                    </div>

                    <button
                      onClick={handleClaimRewards}
                      disabled={claiming || claimableState.totalClaimableEth <= 0}
                      className="w-full py-2.5 rounded-xl bg-gradient-to-r from-[#00B4D8] to-[#0077B6] hover:from-[#0096C7] hover:to-[#023E8A] text-white font-semibold text-xs disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
                    >
                      {claiming ? (
                        <span>Verifying Proof & Claiming...</span>
                      ) : (
                        <span>Claim Rewards {claimableState.unclaimedEpochs.length > 0 ? `(${claimableState.unclaimedEpochs.length} Epochs)` : ''}</span>
                      )}
                    </button>

                    {claimSuccessMsg && (
                      <p className="text-center text-emerald-400 text-[11px] font-medium">{claimSuccessMsg}</p>
                    )}
                  </div>
                </div>
              </div>

              {/* TOKEN CONTRACT INFORMATION */}
              <div className="bg-[#0B1120] border border-[#1D2940] rounded-2xl p-5 shadow-xl shadow-black/20">
                <h3 className="text-white font-semibold text-sm mb-3">Token Contract Details</h3>

                <div className="space-y-2 text-xs">
                  <div className="flex items-center justify-between rounded-lg bg-[#070A12] px-3 py-2 border border-[#1D2940]">
                    <span className="text-[#7D92BC]">Token</span>
                    <span className="text-white font-medium">${displaySymbol} (18 Decimals)</span>
                  </div>

                  <div className="rounded-lg bg-[#070A12] px-3 py-2 border border-[#1D2940]">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[#7D92BC]">Contract Address</span>
                      {tokenData.mintAddress && (
                        <button
                          onClick={copyContractAddress}
                          className="text-[#36BCFF] hover:underline text-[10px] font-medium"
                        >
                          {contractCopied ? 'Copied!' : 'Copy'}
                        </button>
                      )}
                    </div>
                    {tokenData.mintAddress ? (
                      <a
                        href={EVM_ADDRESS_URL(tokenData.mintAddress)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block break-all text-[11px] font-mono text-[#36BCFF] hover:underline"
                      >
                        {tokenData.mintAddress}
                      </a>
                    ) : (
                      <span className="text-[#64799E]">—</span>
                    )}
                  </div>

                  <div className="flex items-center justify-between rounded-lg bg-[#070A12] px-3 py-2 border border-[#1D2940]">
                    <span className="text-[#7D92BC]">Network</span>
                    <span className="text-white font-medium">{EVM_CHAIN_NAME}</span>
                  </div>

                  <div className="flex items-center justify-between rounded-lg bg-[#070A12] px-3 py-2 border border-[#1D2940]">
                    <span className="text-[#7D92BC]">Total Supply</span>
                    <span className="text-white font-medium">1,000,000,000 (1.00B)</span>
                  </div>

                  <div className="flex items-center justify-between rounded-lg bg-[#070A12] px-3 py-2 border border-[#1D2940]">
                    <span className="text-[#7D92BC]">Gas Token</span>
                    <span className="text-white font-medium">{EVM_NATIVE_SYMBOL}</span>
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </main>
    </div>
  );
};

export default TokenPreviewPage;
