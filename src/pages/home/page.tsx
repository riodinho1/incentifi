import { Link } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';

type TokenItem = {
  id: string;
  created_at?: string | number | Date;
  name?: string;
  symbol?: string;
  image_url?: string;
  creator_address?: string;
  timeAgo?: string;
  isNew?: boolean;
  [key: string]: unknown;
};

const categories = [
  { name: 'All Coins', emoji: '🪙' },
  { name: 'Meme', emoji: '😂' },
  { name: 'DeFi', emoji: '💰' },
  { name: 'Gaming', emoji: '🎮' },
  { name: 'AI', emoji: '🤖' },
  { name: 'NFT', emoji: '🖼️' },
  { name: 'Social', emoji: '💬' },
  { name: 'Utility', emoji: '⚙️' },
  { name: 'Other', emoji: '🔥' },
];

const HomePage = () => {
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [tokens, setTokens] = useState<TokenItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('All Coins');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('Newest');

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const fetchTokens = async () => {
      try {
        const { data, error } = await supabase
          .from('tokens')
          .select('*')
          .order('created_at', { ascending: false });

        if (error) throw new Error(error.message);

        let tokensList = ((data || []).map((row: Record<string, unknown>) => ({
          id: String(row.id || ''),
          ...row,
        })) as TokenItem[]);

        // Sort newest first
        tokensList.sort((a, b) => {
          const dateA = new Date(a.created_at || 0);
          const dateB = new Date(b.created_at || 0);
          return dateB.getTime() - dateA.getTime();
        });

        // Add timeAgo and isNew (within 10 minutes)
        const now = Date.now();
        const tenMinutes = 10 * 60 * 1000;
        tokensList = tokensList.map(token => {
          const date = new Date(token.created_at || new Date());
          const secondsAgo = Math.floor((now - date.getTime()) / 1000);
          let timeAgo = 'just now';
          if (secondsAgo >= 60) timeAgo = `${Math.floor(secondsAgo / 60)}m ago`;
          if (secondsAgo >= 3600) timeAgo = `${Math.floor(secondsAgo / 3600)}h ago`;
          if (secondsAgo >= 86400) timeAgo = `${Math.floor(secondsAgo / 86400)}d ago`;
          const isNew = now - date.getTime() < tenMinutes;
          return { ...token, timeAgo, isNew };
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

  const shortenAddress = (addr?: string) => {
    if (!addr) return '';
    return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
  };

  const fakeMC = (index: number) => {
    const mcValues = [4200, 6900, 8500, 12300, 5600, 17800, 32000, 7100];
    return mcValues[index % mcValues.length] || 6900;
  };

  // Filter: only All Coins and Meme show tokens
  let filteredTokens = tokens;

  if (selectedCategory !== 'All Coins' && selectedCategory !== 'Meme') {
    filteredTokens = [];
  }

  // Search filter
  if (searchQuery) {
    filteredTokens = filteredTokens.filter(token =>
      token.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      token.symbol?.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }

  // Sort
  if (sortBy === 'Trending') {
    filteredTokens = [...filteredTokens].sort(() => Math.random() - 0.5);
  } else if (sortBy === 'Top Gainers') {
    filteredTokens = [...filteredTokens].sort((a, b) => {
      const mcA = fakeMC(tokens.indexOf(a));
      const mcB = fakeMC(tokens.indexOf(b));
      return mcB - mcA;
    });
  }

  return (
    <div className="min-h-screen bg-[#0A0A0F]">
      {/* Navigation */}
      <header className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${scrolled ? 'bg-[#0A0A0F] border-b border-[#1A1A20]' : 'bg-transparent'}`}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-16 sm:h-20">
            <Link to="/" className="flex items-center gap-2 sm:gap-3 hover:opacity-80 transition-opacity">
              <img
                src="https://static.readdy.ai/image/97719340ed94173328dfb1241fbbf19e/51991647bb900b0ff0ac5e8230d485ae.png"
                alt="IncentiveFi"
                className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg"
              />
              <span className="text-lg sm:text-xl font-semibold text-[#C0C0C8] tracking-tight">IncentiveFi</span>
            </Link>
           
            <nav className="hidden md:flex items-center gap-8">
              <Link to="/" className="text-[#707078] hover:text-[#14B8A6] transition-colors text-sm font-medium">
                Home
              </Link>
              <Link to="/launch" className="text-[#707078] hover:text-[#14B8A6] transition-colors text-sm font-medium">
                Launch
              </Link>
              <button className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#14B8A6] to-[#0D9488] text-white text-sm font-semibold hover:from-[#0D9488] hover:to-[#0F766E] transition-all whitespace-nowrap cursor-pointer shadow-lg shadow-[#14B8A6]/20">
                Connect Wallet
              </button>
            </nav>
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden w-10 h-10 flex items-center justify-center text-[#C0C0C8] hover:text-[#14B8A6] transition-colors cursor-pointer"
            >
              <i className={`${mobileMenuOpen ? 'ri-close-line' : 'ri-menu-line'} text-2xl`}></i>
            </button>
          </div>
          {mobileMenuOpen && (
            <div className="md:hidden py-4 border-t border-[#1A1A20]">
              <nav className="flex flex-col gap-4">
                <Link to="/" onClick={() => setMobileMenuOpen(false)} className="text-[#707078] hover:text-[#14B8A6] transition-colors text-sm font-medium px-2">
                  Home
                </Link>
                <Link to="/launch" onClick={() => setMobileMenuOpen(false)} className="text-[#707078] hover:text-[#14B8A6] transition-colors text-sm font-medium px-2">
                  Launch
                </Link>
                <button className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#14B8A6] to-[#0D9488] text-white text-sm font-semibold hover:from-[#0D9488] hover:to-[#0F766E] transition-all whitespace-nowrap cursor-pointer shadow-lg shadow-[#14B8A6]/20">
                  Connect Wallet
                </button>
              </nav>
            </div>
          )}
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative min-h-screen flex items-center justify-center overflow-hidden px-4">
        <div className="absolute inset-0 bg-[#0A0A0F]"></div>
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute top-20 left-10 w-48 sm:w-72 h-48 sm:h-72 bg-[#14B8A6]/10 rounded-full blur-3xl"></div>
          <div className="absolute bottom-20 right-10 w-64 sm:w-96 h-64 sm:h-96 bg-[#14B8A6]/10 rounded-full blur-3xl"></div>
        </div>
        <div className="relative z-10 max-w-5xl mx-auto text-center pt-16 sm:pt-0">
          <h1 className="text-4xl sm:text-5xl md:text-7xl font-bold mb-4 sm:mb-6 text-[#E0E0E8] px-4">
            IncentiveFi
          </h1>
          <p className="text-xl sm:text-2xl md:text-3xl text-[#909098] font-light mb-4 sm:mb-8 leading-relaxed px-4">
            Rewarding Long-Term Believers, Penalizing Paper Hands
          </p>
          <p className="text-base sm:text-lg md:text-xl text-[#707078] max-w-3xl mx-auto mb-8 sm:mb-12 leading-relaxed px-4">
            IncentiveFi is a revolutionary token launch platform that incentivizes holding and penalizes early sellers. Create tokens with built-in mechanisms that reward diamond hands and discourage paper hands.
          </p>
          <Link
            to="/launch"
            className="inline-flex items-center gap-2 sm:gap-3 px-6 sm:px-8 py-3 sm:py-4 rounded-full bg-gradient-to-r from-[#14B8A6] to-[#0D9488] text-white text-base sm:text-lg font-semibold hover:from-[#0D9488] hover:to-[#0F766E] transition-all whitespace-nowrap cursor-pointer shadow-xl shadow-[#14B8A6]/30"
          >
            Launch Your Token
            <i className="ri-arrow-right-line text-lg sm:text-xl"></i>
          </Link>
        </div>
      </section>

      {/* Token Listing Section */}
      <section className="relative py-12 sm:py-20 bg-[#08080D]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          {/* Total Launched Counter */}
          <div className="text-center mb-8">
            <p className="text-2xl font-bold text-white">
              {tokens.length} tokens launched 🚀
            </p>
          </div>

          {/* Categories Tabs */}
          <div className="flex flex-wrap gap-3 mb-10 justify-center">
            {categories.map(cat => (
              <button
                key={cat.name}
                onClick={() => setSelectedCategory(cat.name)}
                className={`px-6 py-3 rounded-full font-medium flex items-center gap-2 transition-all ${
                  selectedCategory === cat.name
                    ? 'bg-white text-black shadow-lg'
                    : 'bg-[#1A1A20] text-[#909098] hover:text-white hover:bg-[#25252B]'
                }`}
              >
                <span>{cat.emoji}</span>
                {cat.name}
              </button>
            ))}
          </div>

          {/* Search + Sort Row */}
          <div className="flex flex-col sm:flex-row gap-4 mb-12 items-center justify-between">
            <div className="w-full sm:w-auto max-w-2xl">
              <div className="relative">
                <i className="ri-search-line absolute left-6 top-1/2 -translate-y-1/2 text-[#707078] text-xl"></i>
                <input
                  type="text"
                  placeholder="Search tokens..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-16 pr-6 py-4 rounded-2xl bg-[#1A1A20] text-white placeholder-[#707078] focus:outline-none focus:ring-2 focus:ring-[#14B8A6]"
                />
              </div>
            </div>

            {/* Sort Dropdown */}
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="px-6 py-4 rounded-2xl bg-[#1A1A20] text-white focus:outline-none focus:ring-2 focus:ring-[#14B8A6]"
            >
              <option>Newest</option>
              <option>Trending</option>
              <option>Top Gainers</option>
            </select>
          </div>

          {/* Token Grid */}
          {filteredTokens.length === 0 ? (
            <div className="text-center py-24">
              <div className="w-32 h-32 mx-auto mb-8 rounded-full bg-[#1A1A20] flex items-center justify-center">
                <i className="ri-coin-line text-6xl text-[#707078]"></i>
              </div>
              <h3 className="text-3xl font-bold text-white mb-4">No Tokens Launched Yet</h3>
              <p className="text-[#707078] mb-8 max-w-md mx-auto">Be the first to launch a token with IncentiveFi</p>
              <Link to="/launch" className="px-8 py-4 rounded-full bg-gradient-to-r from-[#14B8A6] to-[#0D9488] text-white font-bold">
                Launch First Token
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {filteredTokens.map((token, index) => (
                <Link
                  key={token.id}
                  to={`/token-preview/${token.symbol}`}
                  className="group bg-[#0F0F15] border border-[#1A1A20] rounded-xl overflow-hidden hover:border-[#14B8A6]/30 hover:scale-[1.03] transition-all duration-300 cursor-pointer relative"
                >
                  {/* NEW Badge */}
                  {token.isNew && (
                    <div className="absolute top-2 left-2 z-10 bg-green-500 text-white text-xs font-bold px-3 py-1 rounded-full animate-pulse">
                      NEW
                    </div>
                  )}

                  <div className="aspect-square relative bg-gradient-to-br from-[#1A1A20] to-[#0F0F15] flex items-center justify-center p-3">
                    {token.image_url ? (
                      <img src={token.image_url} alt={token.name} className="w-full h-full rounded-lg object-cover" />
                    ) : (
                      <div className="w-full h-full rounded-lg bg-gradient-to-br from-[#14B8A6] to-[#0D9488] flex items-center justify-center text-white text-2xl font-bold">
                        {(token.symbol || '??').slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <div className="absolute top-2 right-2 bg-[#0F0F15]/80 backdrop-blur-sm px-2 py-0.5 rounded text-xs text-[#707078]">
                      {token.timeAgo}
                    </div>
                  </div>

                  <div className="p-3">
                    <h3 className="text-white font-bold text-sm truncate mb-1">{token.name}</h3>
                    <p className="text-[#14B8A6] text-lg font-bold mb-1">${token.symbol || '??'}</p>
                    <div className="text-[#707078] text-xs mb-3">
                      {shortenAddress(token.creator_address)} • {token.timeAgo}
                    </div>
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-white text-xs font-bold">MC ${fakeMC(index).toLocaleString()}</span>
                      <div className="w-16 h-1 bg-[#25252B] rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-[#14B8A6] to-[#0D9488] rounded-full" style={{ width: `${Math.random() * 60 + 20}%` }}></div>
                      </div>
                    </div>

                    {/* Buy Button */}
                    <button className="w-full py-2 rounded-lg bg-gradient-to-r from-[#14B8A6] to-[#0D9488] text-white font-bold text-sm hover:opacity-90 transition">
                      Buy
                    </button>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* How It Works Section */}
      <section className="relative py-16 sm:py-24 md:py-32 bg-[#08080D]">
        <div className="absolute inset-0 opacity-5" style={{ backgroundImage: 'linear-gradient(#1A1A20 1px, transparent 1px), linear-gradient(90deg, #1A1A20 1px, transparent 1px)', backgroundSize: '50px 50px' }}></div>
       
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-12 sm:mb-16 md:mb-20">
            <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-[#C0C0C8] mb-4">
              How IncentiveFi Works
            </h2>
            <div className="w-20 sm:w-24 h-1 bg-gradient-to-r from-[#14B8A6] to-[#0D9488] mx-auto rounded-full"></div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 sm:gap-8 md:gap-10">
            <div className="group bg-[#0F0F15] border border-[#1A1A20] rounded-2xl sm:rounded-3xl p-6 sm:p-8 md:p-10 hover:border-[#14B8A6]/30 hover:-translate-y-2 hover:shadow-xl hover:shadow-[#14B8A6]/10 transition-all duration-300 cursor-pointer">
              <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-[#14B8A6]/10 flex items-center justify-center mb-6 sm:mb-8 group-hover:scale-110 transition-transform">
                <i className="ri-rocket-line text-3xl sm:text-4xl text-[#14B8A6]"></i>
              </div>
              <h3 className="text-xl sm:text-2xl font-bold text-[#C0C0C8] mb-3 sm:mb-4">Create Your Token</h3>
              <p className="text-sm sm:text-base text-[#707078] leading-relaxed">
                Launch your token instantly with customizable parameters. Set your token name, symbol, supply, and initial liquidity in minutes. No coding required.
              </p>
            </div>
            <div className="group bg-[#0F0F15] border border-[#1A1A20] rounded-2xl sm:rounded-3xl p-6 sm:p-8 md:p-10 hover:border-[#14B8A6]/30 hover:-translate-y-2 hover:shadow-xl hover:shadow-[#14B8A6]/10 transition-all duration-300 cursor-pointer">
              <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-[#14B8A6]/10 flex items-center justify-center mb-6 sm:mb-8 group-hover:scale-110 transition-transform">
                <i className="ri-shield-check-line text-3xl sm:text-4xl text-[#14B8A6]"></i>
              </div>
              <h3 className="text-xl sm:text-2xl font-bold text-[#C0C0C8] mb-3 sm:mb-4">Set Incentive Rules</h3>
              <p className="text-sm sm:text-base text-[#707078] leading-relaxed">
                Built-in holder reward mechanisms automatically track cost basis and penalize sellers who exit at a loss. Diamond hands are protected and rewarded.
              </p>
            </div>
            <div className="group bg-[#0F0F15] border border-[#1A1A20] rounded-2xl sm:rounded-3xl p-6 sm:p-8 md:p-10 hover:border-[#14B8A6]/30 hover:-translate-y-2 hover:shadow-xl hover:shadow-[#14B8A6]/10 transition-all duration-300 cursor-pointer">
              <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-[#14B8A6]/10 flex items-center justify-center mb-6 sm:mb-8 group-hover:scale-110 transition-transform">
                <i className="ri-line-chart-line text-3xl sm:text-4xl text-[#14B8A6]"></i>
              </div>
              <h3 className="text-xl sm:text-2xl font-bold text-[#C0C0C8] mb-3 sm:mb-4">Watch It Grow</h3>
              <p className="text-sm sm:text-base text-[#707078] leading-relaxed">
                Automatic penalty distribution ensures that paper hands contribute to the treasury. Your token ecosystem grows stronger with every trade.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Benefits Section */}
      <section className="relative py-16 sm:py-24 md:py-32 bg-[#0A0A0F] overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute top-0 left-0 w-64 sm:w-96 h-64 sm:h-96 bg-[#14B8A6]/10 rounded-full blur-3xl"></div>
          <div className="absolute bottom-0 right-0 w-64 sm:w-96 h-64 sm:h-96 bg-[#14B8A6]/10 rounded-full blur-3xl"></div>
        </div>
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6">
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-8 sm:gap-12 lg:gap-16 items-center">
            <div className="lg:col-span-3">
              <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-[#C0C0C8] mb-4 sm:mb-6">
                Why Choose IncentiveFi?
              </h2>
              <p className="text-base sm:text-lg md:text-xl text-[#707078] mb-6 sm:mb-8 md:mb-10 leading-relaxed">
                The first platform designed to reward long-term holders and create sustainable token economies.
              </p>
             
              <div className="space-y-4 sm:space-y-6">
                {[
                  'Automatic cost basis tracking for all holders',
                  'Built-in penalty system for paper hands',
                  'Treasury accumulation from loss-making sells',
                  'Diamond hand protection with zero fees',
                  'Instant token deployment on Solana'
                ].map((feature, index) => (
                  <div
                    key={index}
                    className="flex items-start gap-3 sm:gap-4 group hover:translate-x-2 transition-transform cursor-pointer"
                  >
                    <div className="w-5 h-5 sm:w-6 sm:h-6 rounded-full bg-[#14B8A6]/20 flex items-center justify-center flex-shrink-0 mt-1">
                      <i className="ri-check-line text-[#14B8A6] text-xs sm:text-sm"></i>
                    </div>
                    <span className="text-base sm:text-lg text-[#909098] group-hover:text-[#C0C0C8] transition-colors">
                      {feature}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="lg:col-span-2 mt-8 lg:mt-0">
              <div className="relative">
                <div className="absolute inset-0 bg-[#14B8A6]/10 rounded-2xl sm:rounded-3xl blur-2xl"></div>
                <div className="relative bg-[#0F0F15]/80 backdrop-blur-xl border border-[#14B8A6]/20 rounded-2xl sm:rounded-3xl p-6 sm:p-8">
                  <div className="space-y-4 sm:space-y-6">
                    <div className="flex items-center justify-between">
                      <span className="text-[#707078] text-xs sm:text-sm">Total Tokens Launched</span>
                      <span className="text-xl sm:text-2xl font-bold text-[#14B8A6]">{tokens.length}</span>
                    </div>
                    <div className="h-px bg-[#1A1A20]"></div>
                    <div className="flex items-center justify-between">
                      <span className="text-[#707078] text-xs sm:text-sm">Total Liquidity Locked</span>
                      <span className="text-xl sm:text-2xl font-bold text-[#14B8A6]">$0</span>
                    </div>
                    <div className="h-px bg-[#1A1A20]"></div>
                    <div className="flex items-center justify-between">
                      <span className="text-[#707078] text-xs sm:text-sm">Active Holders</span>
                      <span className="text-xl sm:text-2xl font-bold text-[#14B8A6]">0</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-[#05050A] border-t border-[#0F0F15]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12 sm:py-16 md:py-20">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-8 sm:gap-10 md:gap-12 mb-8 sm:mb-12">
            <div>
              <div className="flex items-center gap-3 mb-4">
                <img
                  src="https://static.readdy.ai/image/97719340ed94173328dfb1241fbbf19e/51991647bb900b0ff0ac5e8230d485ae.png"
                  alt="IncentiveFi"
                  className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg"
                />
                <span className="text-xl sm:text-2xl font-bold text-[#C0C0C8]">IncentiveFi</span>
              </div>
              <p className="text-sm sm:text-base text-[#606068] mb-6">
                The future of incentivized token launches
              </p>
              <div className="flex items-center gap-3">
                <a href="#" className="w-10 h-10 rounded-full bg-[#0F0F15] border border-[#1A1A20] flex items-center justify-center text-[#707078] hover:text-[#14B8A6] hover:border-[#14B8A6]/30 transition-all cursor-pointer">
                  <i className="ri-twitter-x-line text-lg"></i>
                </a>
                <a href="#" className="w-10 h-10 rounded-full bg-[#0F0F15] border border-[#1A1A20] flex items-center justify-center text-[#707078] hover:text-[#14B8A6] hover:border-[#14B8A6]/30 transition-all cursor-pointer">
                  <i className="ri-github-line text-lg"></i>
                </a>
              </div>
            </div>
            <div>
              <h4 className="text-xs sm:text-sm font-semibold text-[#606068] uppercase tracking-wider mb-4">Resources</h4>
              <ul className="space-y-3">
                {[
                  { name: 'Whitepaper', link: '/whitepaper' },
                  { name: 'Audit Report', link: '/audit' }
                ].map((item, index) => (
                  <li key={index}>
                    <Link to={item.link} className="text-sm sm:text-base text-[#707078] hover:text-[#14B8A6] transition-colors inline-flex items-center gap-2 group cursor-pointer">
                      {item.name}
                      <i className="ri-arrow-right-line text-sm opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all"></i>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="text-xs sm:text-sm font-semibold text-[#606068] uppercase tracking-wider mb-4">Community</h4>
              <ul className="space-y-3">
                <li>
                  <a href="#" className="text-sm sm:text-base text-[#707078] hover:text-[#14B8A6] transition-colors inline-flex items-center gap-2 group cursor-pointer">
                    Follow on X
                    <i className="ri-arrow-right-line text-sm opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all"></i>
                  </a>
                </li>
                <li>
                  <a href="#" className="text-sm sm:text-base text-[#707078] hover:text-[#14B8A6] transition-colors inline-flex items-center gap-2 group cursor-pointer">
                    GitHub
                    <i className="ri-arrow-right-line text-sm opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all"></i>
                  </a>
                </li>
              </ul>
            </div>
          </div>
          <div className="pt-6 sm:pt-8 border-t border-[#0F0F15] text-center">
            <p className="text-xs sm:text-sm text-[#606068]">
              © 2025 IncentiveFi. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default HomePage;
