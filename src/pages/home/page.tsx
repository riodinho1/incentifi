import { Link } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  ChevronRight,
  Coins,
  CircleHelp,
  Github,
  LineChart,
  Menu,
  Network,
  Shield,
  Rocket,
  Search,
  ShieldCheck,
  TrendingUp,
  Trophy,
  UserRound,
  Wallet,
  X,
  Zap,
} from 'lucide-react';
import WalletButton from '../../components/WalletButton';
import { supabase } from '../../lib/supabase';

type TokenItem = {
  id: string;
  created_at?: string | number | Date;
  name?: string;
  symbol?: string;
  image_url?: string;
  creator_address?: string;
  description?: string;
  timeAgo?: string;
  isNew?: boolean;
  [key: string]: unknown;
};

const LOGO_URL =
  'https://static.readdy.ai/image/97719340ed94173328dfb1241fbbf19e/51991647bb900b0ff0ac5e8230d485ae.png';
const GITHUB_URL = 'https://github.com/riodinho1/incentifi';

const categories = ['All Coins', 'Meme', 'DeFi', 'Gaming', 'AI', 'Utility'];
const sortOptions = ['Newest', 'Trending', 'Top Gainers'];

const formatAge = (value?: string | number | Date) => {
  const date = new Date(value || new Date());
  const secondsAgo = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (secondsAgo < 60) return 'just now';
  if (secondsAgo < 3600) return `${Math.floor(secondsAgo / 60)}m ago`;
  if (secondsAgo < 86400) return `${Math.floor(secondsAgo / 3600)}h ago`;
  return `${Math.floor(secondsAgo / 86400)}d ago`;
};

const shortenAddress = (addr?: string) => {
  if (!addr) return 'creator hidden';
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
};

const fakeMC = (index: number) => {
  const mcValues = [4200, 6900, 8500, 12300, 5600, 17800, 32000, 7100];
  return mcValues[index % mcValues.length] || 6900;
};

const HomePage = () => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [tokens, setTokens] = useState<TokenItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('All Coins');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('Newest');
  const [howModalOpen, setHowModalOpen] = useState(false);

  useEffect(() => {
    const fetchTokens = async () => {
      try {
        const { data, error } = await supabase
          .from('tokens')
          .select('*')
          .order('created_at', { ascending: false });

        if (error) throw new Error(error.message);

        const tenMinutes = 10 * 60 * 1000;
        const tokensList = ((data || []).map((row: Record<string, unknown>) => {
          const createdAt = row.created_at || new Date();
          return {
            id: String(row.id || ''),
            ...row,
            timeAgo: formatAge(createdAt as string | number | Date),
            isNew: Date.now() - new Date(createdAt as string | number | Date).getTime() < tenMinutes,
          };
        }) as TokenItem[]).sort((a, b) => {
          return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
        });

        setTokens(tokensList);
      } catch (err) {
        console.error('Supabase fetch error:', err);
      }
    };

    fetchTokens();
    const interval = setInterval(fetchTokens, 30000);
    return () => clearInterval(interval);
  }, []);

  const filteredTokens = useMemo(() => {
    let list = selectedCategory === 'All Coins' || selectedCategory === 'Meme' ? tokens : [];

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      list = list.filter((token) => {
        return (
          token.name?.toLowerCase().includes(query) ||
          token.symbol?.toLowerCase().includes(query) ||
          String(token.mint_address || '').toLowerCase().includes(query)
        );
      });
    }

    if (sortBy === 'Trending') {
      list = [...list].sort((a, b) => fakeMC(tokens.indexOf(b)) - fakeMC(tokens.indexOf(a)));
    }

    if (sortBy === 'Top Gainers') {
      list = [...list].sort((a, b) => {
        const aScore = String(a.symbol || '').charCodeAt(0) || 0;
        const bScore = String(b.symbol || '').charCodeAt(0) || 0;
        return bScore - aScore;
      });
    }

    return list;
  }, [searchQuery, selectedCategory, sortBy, tokens]);

  const totalMarketCap = tokens.reduce((sum, _token, index) => sum + fakeMC(index), 0);

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#071012] text-[#E8EEF9]">
      <header className="fixed left-0 right-0 top-0 z-50 border-b border-[#183033] bg-[#071012]/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-3 px-4 sm:h-16 sm:px-6">
          <Link to="/" className="flex min-w-0 items-center gap-3">
            <img src={LOGO_URL} alt="incentifi" className="h-8 w-8 rounded-lg sm:h-9 sm:w-9" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold sm:text-base">incentifi</div>
              <div className="hidden text-[11px] text-[#769196] sm:block">Solana Mainnet</div>
            </div>
          </Link>

          <nav className="hidden items-center gap-2 lg:flex">
            <button
              type="button"
              onClick={() => setHowModalOpen(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-[#1D3539] bg-[#0B171A] px-3 py-2 text-xs font-medium text-[#DDE8EA] transition hover:border-[#14B8A6]/60 hover:text-white"
            >
              <CircleHelp className="h-4 w-4 text-[#14B8A6]" />
              How
            </button>
            <a href="#market" className="inline-flex items-center gap-2 rounded-xl border border-[#1D3539] bg-[#0B171A] px-3 py-2 text-xs font-medium text-[#DDE8EA] transition hover:border-[#14B8A6]/60 hover:text-white">
              <Coins className="h-4 w-4 text-[#14B8A6]" />
              INCENTIFI
            </a>
            <a href="#profile" className="inline-flex items-center gap-2 rounded-xl border border-[#1D3539] bg-[#0B171A] px-3 py-2 text-xs font-medium text-[#DDE8EA] transition hover:border-[#14B8A6]/60 hover:text-white">
              <Trophy className="h-4 w-4 text-[#14B8A6]" />
              Profile
            </a>
            <Link to="/docs" className="inline-flex items-center gap-2 rounded-xl border border-[#1D3539] bg-[#0B171A] px-3 py-2 text-xs font-medium text-[#DDE8EA] transition hover:border-[#14B8A6]/60 hover:text-white">
              <BookOpen className="h-4 w-4 text-[#14B8A6]" />
              Docs
            </Link>
            <Link to="/launch" className="inline-flex items-center gap-2 rounded-xl bg-[#14B8A6] px-4 py-2 text-xs font-semibold text-[#031011] transition hover:bg-[#4FE0D2]">
              <Rocket className="h-4 w-4" />
              Create Coin
            </Link>
            <WalletButton />
          </nav>

          <nav className="hidden items-center gap-5 md:flex lg:hidden">
            <button type="button" onClick={() => setHowModalOpen(true)} className="text-sm font-semibold text-[#8EA2A7] transition hover:text-[#14B8A6]">
              How
            </button>
            <Link to="/docs" className="inline-flex items-center gap-2 text-sm text-[#8EA2A7] transition hover:text-[#14B8A6]">
              <BookOpen className="h-4 w-4" />
              Docs
            </Link>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm text-[#8EA2A7] transition hover:text-[#14B8A6]">
              <Github className="h-4 w-4" />
              GitHub
            </a>
            <WalletButton />
          </nav>

          <button
            type="button"
            onClick={() => setMobileMenuOpen((open) => !open)}
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#183033] text-[#8EA2A7] md:hidden"
            aria-label="Open navigation"
          >
            {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {mobileMenuOpen && (
          <div className="border-t border-[#183033] px-4 py-4 md:hidden">
            <nav className="mx-auto flex max-w-7xl flex-col gap-3">
              <Link to="/docs" onClick={() => setMobileMenuOpen(false)} className="flex items-center gap-2 rounded-xl px-2 py-2 text-[#8EA2A7]">
                <BookOpen className="h-4 w-4" />
                Docs
              </Link>
              <button
                type="button"
                onClick={() => {
                  setHowModalOpen(true);
                  setMobileMenuOpen(false);
                }}
                className="flex items-center gap-2 rounded-xl px-2 py-2 text-left text-[#8EA2A7]"
              >
                <CircleHelp className="h-4 w-4" />
                How it works
              </button>
              <Link to="/launch" onClick={() => setMobileMenuOpen(false)} className="flex items-center gap-2 rounded-xl px-2 py-2 text-[#8EA2A7]">
                <Rocket className="h-4 w-4" />
                Create Coin
              </Link>
              <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-xl px-2 py-2 text-[#8EA2A7]">
                <Github className="h-4 w-4" />
                GitHub
              </a>
              <WalletButton />
            </nav>
          </div>
        )}
      </header>

      <main className="pt-14 sm:pt-16">
        <section className="border-b border-[#10282B] bg-[#091719]">
          <div className="mx-auto grid w-full min-w-0 max-w-7xl gap-7 px-4 py-8 sm:px-6 sm:py-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)] lg:items-center">
            <div className="min-w-0">
              <div className="mb-4 inline-flex max-w-[21rem] items-center gap-2 rounded-full border border-[#14B8A6]/25 bg-[#14B8A6]/10 px-3 py-1.5 text-xs font-semibold text-[#72E0D5] sm:max-w-full">
                <TrendingUp className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 truncate">Launch on incentifi. Hold with purpose.</span>
              </div>
              <h1 className="max-w-[22rem] text-3xl font-bold leading-[1.08] tracking-normal text-white sm:max-w-2xl sm:text-4xl lg:text-5xl">
                Launch coins that reward holders.
              </h1>
              <p className="mt-4 max-w-[22rem] break-words text-sm leading-6 text-[#8EA2A7] [overflow-wrap:anywhere] sm:max-w-xl sm:text-base">
                incentifi gives every creator a launch page, coin discovery, wallet flow, and an incentive-routing mechanic that can direct below-entry exits back into the project treasury.
              </p>
              <div className="mt-6 flex min-w-0 flex-col gap-3 sm:flex-row">
                <Link
                  to="/launch"
                  className="inline-flex min-w-0 items-center justify-center gap-2 rounded-xl bg-[#14B8A6] px-4 py-3 text-sm font-semibold text-[#031011] transition hover:bg-[#4FE0D2]"
                >
                  <Rocket className="h-5 w-5 shrink-0" />
                  <span className="truncate">Create Coin</span>
                </Link>
                <Link
                  to="/docs"
                  className="inline-flex min-w-0 items-center justify-center gap-2 rounded-xl border border-[#183033] px-4 py-3 text-sm font-semibold text-[#B8C9CE] transition hover:border-[#14B8A6]/50 hover:text-white"
                >
                  <BookOpen className="h-5 w-5 shrink-0" />
                  <span className="truncate">Read Docs</span>
                </Link>
              </div>
            </div>

            <div className="min-w-0 rounded-3xl border border-[#183033] bg-[#0B171A] p-4 shadow-2xl shadow-black/30">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <div className="text-xs uppercase text-[#587075]">Live platform</div>
                  <div className="text-xl font-semibold">incentifi market</div>
                </div>
                <Coins className="h-8 w-8 text-[#14B8A6]" />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[
                  ['Coins', tokens.length.toString()],
                  ['Liquidity', '$0'],
                  ['MCap', `$${totalMarketCap.toLocaleString()}`],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-2xl border border-[#183033] bg-[#071012] p-4">
                    <div className="text-xs text-[#708990]">{label}</div>
                    <div className="mt-1 text-lg font-semibold text-white">{value}</div>
                  </div>
                ))}
              </div>
              <div className="mt-4 overflow-hidden rounded-2xl border border-[#183033] bg-[#071012]">
                <div className="flex animate-[pulse_4s_ease-in-out_infinite] whitespace-nowrap px-4 py-3 text-sm text-[#8EA2A7]">
                  <span className="mr-8 text-[#14B8A6]">$INCENTIFI</span>
                  <span className="mr-8">below-entry contribution: 50%</span>
                  <span className="mr-8">upside exits: 0% extra fee</span>
                  <span>treasury support through incentive routing</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="market" className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14">
          <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-2xl font-bold text-white sm:text-3xl">Launched coins</h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-[#769196]">
                Search, filter, and open any coin to view its trading page, chart area, holder details, and creator links.
              </p>
            </div>
            <Link to="/launch" className="inline-flex items-center gap-2 text-sm font-semibold text-[#14B8A6]">
              Launch your coin <ChevronRight className="h-4 w-4" />
            </Link>
          </div>

          <div className="mb-5 flex gap-2 overflow-x-auto pb-1">
            {categories.map((category) => (
              <button
                key={category}
                type="button"
                onClick={() => setSelectedCategory(category)}
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition ${
                  selectedCategory === category
                    ? 'bg-white text-[#061012]'
                    : 'border border-[#183033] bg-[#0B171A] text-[#8EA2A7] hover:text-white'
                }`}
              >
                {category}
              </button>
            ))}
          </div>

          <div className="mb-8 grid gap-3 md:grid-cols-[1fr_auto]">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#587075]" />
              <input
                type="text"
                placeholder="Search name, symbol, or contract"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                className="h-14 w-full rounded-2xl border border-[#183033] bg-[#0B171A] pl-12 pr-4 text-white outline-none transition placeholder:text-[#587075] focus:border-[#14B8A6]"
              />
            </label>
            <select
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value)}
              className="h-14 rounded-2xl border border-[#183033] bg-[#0B171A] px-4 text-white outline-none focus:border-[#14B8A6]"
            >
              {sortOptions.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          </div>

          {filteredTokens.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-[#183033] bg-[#0B171A] px-6 py-16 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-[#14B8A6]/10 text-[#14B8A6]">
                <Coins className="h-8 w-8" />
              </div>
              <h3 className="mt-6 text-2xl font-bold text-white">No coins launched yet</h3>
              <p className="mx-auto mt-2 max-w-md text-[#769196]">Bring the first incentifi coin to market.</p>
              <Link to="/launch" className="mt-6 inline-flex items-center justify-center rounded-2xl bg-[#14B8A6] px-6 py-3 font-semibold text-[#031011]">
                Create First Coin
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {filteredTokens.map((token, index) => (
                <Link
                  key={token.id}
                  to={`/token-preview/${token.symbol}`}
                  className="group overflow-hidden rounded-2xl border border-[#183033] bg-[#0B171A] transition hover:-translate-y-1 hover:border-[#14B8A6]/50"
                >
                  <div className="relative aspect-square bg-[#071012] p-3">
                    {token.isNew && (
                      <div className="absolute left-3 top-3 z-10 rounded-full bg-[#14B8A6] px-3 py-1 text-xs font-semibold text-[#031011]">
                        NEW
                      </div>
                    )}
                    {token.image_url ? (
                      <img src={token.image_url} alt={token.name} className="h-full w-full rounded-xl object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center rounded-xl bg-[#14B8A6]/15 text-2xl font-bold text-[#72E0D5]">
                        {(token.symbol || '??').slice(0, 2).toUpperCase()}
                      </div>
                    )}
                  </div>
                  <div className="p-3">
                    <div className="truncate text-sm font-semibold text-white">{token.name || 'Untitled coin'}</div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="truncate text-lg font-bold text-[#14B8A6]">${token.symbol || '??'}</span>
                      <span className="shrink-0 text-xs text-[#587075]">{token.timeAgo}</span>
                    </div>
                    <div className="mt-2 truncate text-xs text-[#708990]">{shortenAddress(token.creator_address)}</div>
                    <div className="mt-3 flex items-center justify-between">
                      <span className="text-xs font-semibold text-white">MC ${fakeMC(index).toLocaleString()}</span>
                      <span className="rounded-full bg-[#14B8A6]/10 px-2 py-1 text-xs text-[#72E0D5]">Trade</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className="border-y border-[#10282B] bg-[#091719]">
          <div className="mx-auto grid max-w-7xl gap-4 px-4 py-10 sm:px-6 md:grid-cols-3">
            {[
              {
                icon: Rocket,
                title: 'Create',
                body: 'Set coin name, symbol, image, socials, and initial liquidity from one guided launch form.',
              },
              {
                icon: ShieldCheck,
                title: 'Incentivize',
                body: 'Below-entry exits can route a contribution into treasury, while upside exits keep the standard flow.',
              },
              {
                icon: LineChart,
                title: 'Trade',
                body: 'Each launched coin gets a market page with chart space, creator information, and buy flow.',
              },
            ].map((item) => (
              <div key={item.title} className="rounded-3xl border border-[#183033] bg-[#071012] p-6">
                <item.icon className="h-8 w-8 text-[#14B8A6]" />
                <h3 className="mt-5 text-xl font-bold text-white">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-[#769196]">{item.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="profile" className="border-b border-[#10282B] bg-[#071012]">
          <div className="mx-auto grid max-w-7xl gap-8 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
            <div>
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#14B8A6]/25 bg-[#14B8A6]/10 px-4 py-2 text-sm font-semibold text-[#72E0D5]">
                <UserRound className="h-4 w-4" />
                Creator profile
              </div>
              <h2 className="text-3xl font-bold text-white sm:text-4xl">Every launch gets a stronger identity.</h2>
              <p className="mt-4 max-w-xl text-base leading-7 text-[#8EA2A7]">
                incentifi gives each coin a clear profile surface for its symbol, creator address, market stats, social links, chart area, and trading controls.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                ['Creator signal', 'Show who launched the coin and where holders can verify project links.'],
                ['Market context', 'Keep market cap, liquidity, volume, and 24h movement close to the token identity.'],
                ['Trading surface', 'Give buyers and sellers a focused place to review the rule before acting.'],
                ['Documentation path', 'Send confused users straight into the docs without leaving the product flow.'],
              ].map(([title, body]) => (
                <div key={title} className="rounded-3xl border border-[#183033] bg-[#0B171A] p-6">
                  <h3 className="text-lg font-bold text-white">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-[#769196]">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-b border-[#10282B] bg-[#091719]">
          <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16">
            <div className="mb-8 max-w-3xl">
              <h2 className="text-3xl font-bold text-white sm:text-4xl">The incentifi route is visible before the trade.</h2>
              <p className="mt-4 text-base leading-7 text-[#8EA2A7]">
                The flow is designed so users do not guess what happens. They see the rule, see the market, connect a wallet, and decide with the incentive model in front of them.
              </p>
            </div>
            <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
              <div className="rounded-3xl border border-[#183033] bg-[#071012] p-5 sm:p-7">
                <div className="mb-5 flex items-center gap-3 text-xl font-bold text-white">
                  <Zap className="h-6 w-6 text-[#14B8A6]" />
                  Below-entry route
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  {['Exit below entry', '50% contribution route', 'Treasury support'].map((item, index) => (
                    <div key={item} className="contents">
                      <div className="rounded-2xl bg-[#0B171A] px-4 py-4 text-center font-semibold text-white sm:flex-1">
                        {item}
                      </div>
                      {index < 2 && <div className="hidden text-center text-[#587075] sm:block">to</div>}
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-3xl border border-[#183033] bg-[#071012] p-5 sm:p-7">
                <div className="mb-5 flex items-center gap-3 text-xl font-bold text-white">
                  <Shield className="h-6 w-6 text-[#14B8A6]" />
                  Upside exit
                </div>
                <p className="text-sm leading-6 text-[#8EA2A7]">
                  If a holder exits above entry, the contribution route does not apply. The mechanism is meant to make the treasury path clear before the trade, so the community understands how value can flow through the system.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="border-b border-[#10282B] bg-[#071012]">
          <div className="mx-auto grid max-w-7xl gap-6 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-3">
            {[
              {
                icon: Wallet,
                title: 'Wallet first',
                body: 'Browse without connecting. Connect only when you are ready to create or trade.',
              },
              {
                icon: Network,
                title: 'Solana native',
                body: 'Built around Solana Mainnet flows, RPC status, token pages, and wallet confirmations.',
              },
              {
                icon: ShieldCheck,
                title: 'Rule clarity',
                body: 'Docs, market cards, token pages, and the How modal all explain the same incentifi routing model.',
              },
            ].map((item) => (
              <div key={item.title} className="rounded-3xl border border-[#183033] bg-[#0B171A] p-6">
                <item.icon className="h-8 w-8 text-[#14B8A6]" />
                <h3 className="mt-5 text-xl font-bold text-white">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-[#769196]">{item.body}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      {howModalOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm">
          <div className="scrollbar-stealth max-h-[86vh] w-full max-w-4xl overflow-y-auto rounded-3xl border border-[#264247] bg-[#102022] shadow-2xl shadow-black/60">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[#264247] bg-[#102022] px-5 py-5 sm:px-8">
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#14B8A6]/15 text-[#14B8A6]">
                  <CircleHelp className="h-7 w-7" />
                </div>
                <h2 className="text-2xl font-bold text-white sm:text-3xl">How incentifi Works</h2>
              </div>
              <button
                type="button"
                onClick={() => setHowModalOpen(false)}
                className="flex h-10 w-10 items-center justify-center rounded-xl text-[#8EA2A7] transition hover:bg-white/5 hover:text-white"
                aria-label="Close how incentifi works"
              >
                <X className="h-6 w-6" />
              </button>
            </div>

            <div className="space-y-7 p-5 sm:p-8">
              <div className="rounded-3xl border border-[#14B8A6]/25 bg-[#14B8A6]/10 p-6">
                <div className="mb-3 flex items-center gap-3 text-xl font-bold text-white">
                  <Zap className="h-6 w-6 text-[#14B8A6]" />
                  Core Rule
                </div>
                <p className="text-2xl font-bold text-white">
                  Exit below entry <span className="text-[#8EA2A7]">to</span> <span className="text-[#14B8A6]">50% treasury contribution</span>
                </p>
                <p className="mt-3 text-[#9BB1B6]">The contribution is not burned. It routes value toward the project treasury.</p>
              </div>

              <div>
                <h3 className="mb-4 text-sm font-bold uppercase tracking-widest text-[#8EA2A7]">Incentifi flow</h3>
                <div className="grid gap-3 sm:grid-cols-4">
                  {['Below-entry exit', '50% contribution', 'Treasury', 'Growth tools'].map((step) => (
                    <div key={step} className="rounded-2xl border border-[#1D3539] bg-[#071012] px-4 py-4 text-center font-semibold text-white">
                      {step}
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid gap-5 md:grid-cols-2">
                <div className="rounded-3xl border border-emerald-500/30 bg-emerald-500/10 p-6">
                  <h3 className="text-xl font-bold text-emerald-300">On incentifi</h3>
                  <ul className="mt-4 space-y-3 text-[#B9CBCF]">
                    <li>Contract-aware flow checks the trade context.</li>
                    <li>The routing model is shown before action.</li>
                    <li>Users see how treasury support can happen through below-entry exits.</li>
                  </ul>
                </div>
                <div className="rounded-3xl border border-rose-500/30 bg-rose-500/10 p-6">
                  <h3 className="text-xl font-bold text-rose-300">Outside the flow</h3>
                  <ul className="mt-4 space-y-3 text-[#B9CBCF]">
                    <li>Users may miss the holder-incentive context.</li>
                    <li>Project links and rules can be harder to verify.</li>
                    <li>The launch story becomes fragmented.</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <footer className="border-t border-[#10282B] bg-[#071012]">
        <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-8 sm:px-6 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <img src={LOGO_URL} alt="incentifi" className="h-10 w-10 rounded-xl" />
            <div>
              <div className="font-semibold text-white">incentifi</div>
              <div className="text-sm text-[#769196]">Solana Mainnet</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-5 text-sm text-[#8EA2A7]">
            <Link to="/docs" className="inline-flex items-center gap-2 transition hover:text-[#14B8A6]">
              <BookOpen className="h-4 w-4" />
              Docs
            </Link>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 transition hover:text-[#14B8A6]">
              <Github className="h-4 w-4" />
              GitHub
            </a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="transition hover:text-[#14B8A6]">GitHub</a>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default HomePage;
