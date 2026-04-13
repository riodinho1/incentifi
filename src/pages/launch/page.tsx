import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import WalletButton from '../../components/WalletButton';
import { useWalletConnected } from '../../hooks/useWalletConnected';
import { createRealToken } from '../../lib/createToken';
import { supabase } from '../../lib/supabase';
import { SOLANA_NETWORK } from '../../lib/network';

const LaunchPage = () => {
  const connected = useWalletConnected();
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [formData, setFormData] = useState({
    tokenName: '',
    tokenSymbol: '',
    description: '',
    imageUrl: '',
    website: '',
    twitter: '',
    telegram: '',
    initialLiquidity: '0.1'
  });
  const [errors, setErrors] = useState<{tokenName?: string; tokenSymbol?: string}>({});

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const validate = () => {
    const newErrors: {tokenName?: string; tokenSymbol?: string} = {};
    if (!formData.tokenName.trim()) newErrors.tokenName = 'Token name is required';
    if (!formData.tokenSymbol.trim()) newErrors.tokenSymbol = 'Token symbol is required';
    if (formData.tokenSymbol.length > 10) newErrors.tokenSymbol = 'Symbol must be 10 characters or less';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    if (!connected) return alert('Connect wallet first');

    try {
      const provider = (window as any).solana;
      if (!provider) throw new Error('Phantom wallet not detected');

      // Show user we're starting
      alert(`Creating your token on Solana ${SOLANA_NETWORK}...\nPlease approve the transaction in Phantom.`);

      const result = await createRealToken(provider);

      alert(`Token launched!\n$${formData.tokenSymbol.toUpperCase()}\nMint: ${result.mint}`);

      // Save token to Supabase
      try {
        const { error } = await supabase.from('tokens').insert({
          name: formData.tokenName,
          symbol: formData.tokenSymbol.toUpperCase(),
          description: formData.description || '',
          image_url: formData.imageUrl || '',
          website: formData.website || '',
          twitter: formData.twitter || '',
          telegram: formData.telegram || '',
          mint_address: result.mint,
          creator_address: provider.publicKey.toString(),
          created_at: new Date().toISOString(),
        });
        if (error) throw new Error(error.message);
        alert('Token launched and saved!');
      } catch (err: unknown) {
        console.error('Supabase save error:', err);
        const message = err instanceof Error ? err.message : 'Unknown Supabase error';
        alert(`Token minted but save failed: ${message}`);
      }

      // Save data for preview
      const tokenData = {
        ...formData,
        tokenSymbol: formData.tokenSymbol.trim().toUpperCase(),
        mintAddress: result.mint,
      };
      localStorage.setItem('previewToken', JSON.stringify(tokenData));

      navigate(`/token-preview/${tokenData.tokenSymbol}`);
    } catch (err: any) {
      console.error('Token creation error:', err);
      alert('Failed to create token: ' + (err.message || 'Unknown error. Check console for details.'));
    }
  };

  return (
    <div className="min-h-screen bg-[#0E1518]">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-[#0E1518] border-b border-[#2A3338]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-16 sm:h-20">
            <Link to="/" className="flex items-center gap-2 sm:gap-3 hover:opacity-80 transition-opacity">
              <img 
                src="https://static.readdy.ai/image/97719340ed94173328dfb1241fbbf19e/51991647bb900b0ff0ac5e8230d485ae.png" 
                alt="IncentiveFi" 
                className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg"
              />
              <span className="text-lg sm:text-xl font-semibold text-[#E9E1D8] tracking-tight">IncentiveFi</span>
            </Link>
            
            <nav className="hidden md:flex items-center gap-8">
              <Link to="/" className="text-[#9FA6A3] hover:text-[#E9E1D8] transition-colors text-sm font-medium">
                Home
              </Link>
              <Link to="/launch" className="text-[#E9E1D8] font-medium text-sm">
                Launch
              </Link>
              <WalletButton />
            </nav>

            {/* Mobile menu button */}
            <button 
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden w-10 h-10 flex items-center justify-center text-[#E9E1D8] hover:text-[#00D9FF] transition-colors"
            >
              <i className={`${mobileMenuOpen ? 'ri-close-line' : 'ri-menu-line'} text-2xl`}></i>
            </button>
          </div>

          {/* Mobile menu */}
          {mobileMenuOpen && (
            <div className="md:hidden py-4 border-t border-[#2A3338]">
              <nav className="flex flex-col gap-4">
                <Link 
                  to="/" 
                  onClick={() => setMobileMenuOpen(false)}
                  className="text-[#9FA6A3] hover:text-[#E9E1D8] transition-colors text-sm font-medium px-2"
                >
                  Home
                </Link>
                <Link 
                  to="/launch" 
                  onClick={() => setMobileMenuOpen(false)}
                  className="text-[#E9E1D8] font-medium text-sm px-2"
                >
                  Launch
                </Link>
                <WalletButton />
              </nav>
            </div>
          )}
        </div>
      </header>

      <main className="pt-16 sm:pt-20">
        {/* Hero */}
        <section className="relative py-12 sm:py-16 md:py-20 bg-gradient-to-b from-[#1a0a2e] to-[#0E1518] overflow-hidden">
          <div className="absolute inset-0">
            <div className="absolute top-0 left-1/4 w-64 sm:w-96 h-64 sm:h-96 bg-[#00D9FF]/10 rounded-full blur-3xl"></div>
            <div className="absolute bottom-0 right-1/4 w-64 sm:w-96 h-64 sm:h-96 bg-[#9D00FF]/10 rounded-full blur-3xl"></div>
          </div>
          
          <div className="relative max-w-4xl mx-auto px-4 sm:px-6 text-center">
            <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold mb-3 sm:mb-4 bg-gradient-to-r from-[#00D9FF] via-[#9D00FF] to-[#FF00E5] bg-clip-text text-transparent">
              Launch Your Token
            </h1>
            <p className="text-base sm:text-lg md:text-xl text-[#9FA6A3]">
              Create your incentivized token in minutes
            </p>
          </div>
        </section>

        {/* Form */}
        <section className="py-8 sm:py-12 md:py-16">
          <div className="max-w-4xl mx-auto px-4 sm:px-6">
            <div className="mb-6 sm:mb-8">
              <Link 
                to="/"
                className="inline-flex items-center gap-2 text-sm text-[#9FA6A3] hover:text-[#E9E1D8] transition-colors"
              >
                <i className="ri-arrow-left-line"></i>
                Back to Home
              </Link>
            </div>

            <form onSubmit={handleSubmit} className="bg-[#1A1A2E] border border-[#2A3338] rounded-2xl sm:rounded-3xl p-6 sm:p-8 md:p-12 shadow-2xl">
              {/* Wallet Notice */}
              <div className="mb-6 sm:mb-8 p-4 sm:p-6 rounded-xl sm:rounded-2xl bg-[#0E1518] border border-[#2A3338] text-center">
                <p className="text-xs sm:text-sm text-[#9FA6A3] mb-3 sm:mb-4">Connect your wallet to launch a token</p>
                <WalletButton />
              </div>

              <div className="space-y-5 sm:space-y-6">
                {/* Token Name */}
                <div>
                  <label className="block text-xs sm:text-sm font-semibold text-[#E9E1D8] mb-2 sm:mb-3 uppercase tracking-wide">
                    Token Name *
                  </label>
                  <input
                    type="text"
                    name="tokenName"
                    value={formData.tokenName}
                    onChange={handleInputChange}
                    placeholder="e.g., Diamond Hand Token"
                    maxLength={32}
                    className="w-full px-4 sm:px-5 py-3 sm:py-4 rounded-xl bg-[#0F0F1A] border border-[#2A3338] text-[#E9E1D8] placeholder-[#5F6A6E] focus:outline-none focus:border-[#00D9FF] transition-colors text-sm sm:text-base"
                  />
                  <p className="text-xs text-[#5F6A6E] mt-2">{formData.tokenName.length}/32 characters</p>
                  {errors.tokenName && <p className="text-red-400 text-xs mt-1">{errors.tokenName}</p>}
                </div>

                {/* Token Symbol */}
                <div>
                  <label className="block text-xs sm:text-sm font-semibold text-[#E9E1D8] mb-2 sm:mb-3 uppercase tracking-wide">
                    Symbol (Ticker) *
                  </label>
                  <input
                    type="text"
                    name="tokenSymbol"
                    value={formData.tokenSymbol}
                    onChange={handleInputChange}
                    placeholder="e.g., DHT"
                    maxLength={10}
                    className="w-full px-4 sm:px-5 py-3 sm:py-4 rounded-xl bg-[#0F0F1A] border border-[#2A3338] text-[#E9E1D8] placeholder-[#5F6A6E] focus:outline-none focus:border-[#00D9FF] transition-colors uppercase text-sm sm:text-base"
                  />
                  <p className="text-xs text-[#5F6A6E] mt-2">{formData.tokenSymbol.length}/10 characters · Duplicates not allowed</p>
                  {errors.tokenSymbol && <p className="text-red-400 text-xs mt-1">{errors.tokenSymbol}</p>}
                </div>

                {/* Description */}
                <div>
                  <label className="block text-xs sm:text-sm font-semibold text-[#E9E1D8] mb-2 sm:mb-3 uppercase tracking-wide">
                    Description
                  </label>
                  <textarea
                    name="description"
                    value={formData.description}
                    onChange={handleInputChange}
                    placeholder="Describe your token..."
                    rows={4}
                    maxLength={500}
                    className="w-full px-4 sm:px-5 py-3 sm:py-4 rounded-xl bg-[#0F0F1A] border border-[#2A3338] text-[#E9E1D8] placeholder-[#5F6A6E] focus:outline-none focus:border-[#00D9FF] transition-colors resize-none text-sm sm:text-base"
                  />
                  <p className="text-xs text-[#5F6A6E] mt-2">{formData.description.length}/500 characters</p>
                </div>

                {/* Token Image URL */}
                <div>
                  <label className="block text-xs sm:text-sm font-semibold text-[#E9E1D8] mb-2 sm:mb-3 uppercase tracking-wide">
                    Token Image URL (Optional)
                  </label>
                  <input
                    type="url"
                    name="imageUrl"
                    value={formData.imageUrl}
                    onChange={handleInputChange}
                    placeholder="https://example.com/my-token-logo.png"
                    className="w-full px-4 sm:px-5 py-3 sm:py-4 rounded-xl bg-[#0F0F1A] border border-[#2A3338] text-[#E9E1D8] placeholder-[#5F6A6E] focus:outline-none focus:border-[#00D9FF] transition-colors text-sm sm:text-base"
                  />
                  <p className="text-xs text-[#5F6A6E] mt-2">
                    Direct link to your token's logo image (PNG, JPG, SVG). If left empty, initials will be shown.
                  </p>
                </div>

                {/* Social Links */}
                <div className="space-y-4">
                  <label className="block text-xs sm:text-sm font-semibold text-[#E9E1D8] uppercase tracking-wide">
                    Social Links (Optional)
                  </label>
                  
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-xs text-[#5F6A6E] mb-2 uppercase">Website</label>
                      <div className="relative">
                        <i className="ri-global-line absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 text-[#5F6A6E] text-sm"></i>
                        <input
                          type="url"
                          name="website"
                          value={formData.website}
                          onChange={handleInputChange}
                          placeholder="https://mytoken.com"
                          className="w-full pl-9 sm:pl-11 pr-3 sm:pr-4 py-2.5 sm:py-3 rounded-xl bg[#0F0F1A] border border-[#2A3338] text-[#E9E1D8] placeholder-[#5F6A6E] focus:outline-none focus:border-[#00D9FF] transition-colors text-xs sm:text-sm"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs text-[#5F6A6E] mb-2 uppercase">X (Twitter)</label>
                      <div className="relative">
                        <i className="ri-twitter-x-line absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 text [#5F6A6E] text-sm"></i>
                        <input
                          type="url"
                          name="twitter"
                          value={formData.twitter}
                          onChange={handleInputChange}
                          placeholder="https://x.com/mytoken"
                          className="w-full pl-9 sm:pl-11 pr-3 sm:pr-4 py-2.5 sm:py-3 rounded-xl bg[#0F0F1A] border border-[#2A3338] text-[#E9E1D8] placeholder-[#5F6A6E] focus:outline-none focus:border-[#00D9FF] transition-colors text-xs sm:text-sm"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs text-[#5F6A6E] mb-2 uppercase">Telegram</label>
                      <div className="relative">
                        <i className="ri-telegram-line absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 text [#5F6A6E] text-sm"></i>
                        <input
                          type="url"
                          name="telegram"
                          value={formData.telegram}
                          onChange={handleInputChange}
                          placeholder="https://t.me/mytoken"
                          className="w-full pl-9 sm:pl-11 pr-3 sm:pr-4 py-2.5 sm:py-3 rounded-xl bg [#0F0F1A] border border-[#2A3338] text-[#E9E1D8] placeholder-[#5F6A6E] focus:outline-none focus:border [#00D9FF] transition-colors text-xs sm:text-sm"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Token Supply Info */}
                <div className="p-4 sm:p-5 rounded-xl bg [#0F0F1A] border border-[#2A3338]">
                  <div className="flex items-center justify-between text-xs sm:text-sm mb-3">
                    <span className="text-[#5F6A6E]">Token Supply</span>
                    <span className="text-[#E9E1D8] font-semibold">1,000,000,000 (1B)</span>
                  </div>
                  <div className="flex items-center justify-between text-xs sm:text-sm">
                    <span className="text-[#5F6A6E]">Decimals</span>
                    <span className="text [#E9E1D8] font-semibold">6 (Standard)</span>
                  </div>
                </div>

                {/* Initial Liquidity */}
                <div>
                  <label className="block text-xs sm:text-sm font-semibold text-[#E9E1D8] mb-2 sm:mb-3 uppercase tracking-wide">
                    Initial Liquidity (SOL)
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      name="initialLiquidity"
                      value={formData.initialLiquidity}
                      onChange={handleInputChange}
                      placeholder="0.1"
                      step="0.01"
                      min="0.01"
                      className="w-full px-4 sm:px-5 py-3 sm:py-4 pr-16 sm:pr-20 rounded-xl bg [#0F0F1A] border border-[#2A3338] text-[#E9E1D8] placeholder-[#5F6A6E] focus:outline-none focus:border [#00D9FF] transition-colors text-sm sm:text-base"
                    />
                    <span className="absolute right-4 sm:right-5 top-1/2 -translate-y-1/2 text [#9FA6A3] font-semibold text-sm sm:text-base">
                      SOL
                    </span>
                  </div>
                </div>

                {/* Incentive Mechanism Info */}
                <div className="p-4 sm:p-6 rounded-xl bg-gradient-to-r from-[#00D9FF]/10 to-[#9D00FF]/10 border border-[#00D9FF]/30">
                  <div className="flex items-start gap-3 sm:gap-4">
                    <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-gradient-to-r from-[#00D9FF] to [#9D00FF] flex items-center justify-center flex-shrink-0">
                      <i className="ri-information-line text-white text-sm sm:text-base"></i>
                    </div>
                    <div>
                      <p className="text-xs sm:text-sm font-semibold text-[#E9E1D8] mb-2">
                        IncentiveFi Mechanism: 50% Penalty
                      </p>
                      <p className="text-xs text-[#9FA6A3] leading-relaxed">
                        Anyone who sells this token at a loss will have 50% of their SOL proceeds sent to the treasury. Diamond hands pay nothing. This mechanism incentivizes long-term holding and penalizes paper hands.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Submit Button */}
                <button
                  type="submit"
                  disabled={!connected}
                  className={`w-full py-4 sm:py-5 rounded-xl text-white text-base sm:text-lg font-bold transition-all whitespace-nowrap ${
                    connected
                      ? 'bg-gradient-to-r from-[#00D9FF] to [#9D00FF] hover:shadow-2xl hover:shadow-[#00D9FF]/30 hover:scale-[1.02] cursor-pointer'
                      : 'bg-gray-700 opacity-60 cursor-not-allowed'
                  }`}
                >
                  {connected ? 'Create Token' : 'Connect Wallet First'}
                </button>
              </div>
            </form>

            {/* How It Works Panel */}
            <div className="mt-12 sm:mt-16 p-6 sm:p-8 md:p-10 rounded-2xl sm:rounded-3xl bg-[#1A1A2E]/50 border-2 border-dashed border-[#00D9FF]/30">
              <h2 className="text-xl sm:text-2xl font-bold text-[#E9E1D8] mb-4 sm:mb-6">How Token Creation Works</h2>
              <div className="space-y-4 sm:space-y-5">
                {[
                  {
                    number: '1',
                    title: 'Token Created',
                    description: '1B tokens minted to platform pool with your custom parameters'
                  },
                  {
                    number: '2',
                    title: 'Platform LP (80%)',
                    description: 'Creates trading pool on our platform with initial liquidity'
                  },
                  {
                    number: '3',
                    title: 'Incentive Tax Applied',
                    description: '50% tax on selling at a loss enforced on all trades automatically'
                  },
                  {
                    number: '4',
                    title: 'Diamond Hand Protection',
                    description: 'All trading happens with the incentive mechanism enforced. Diamond hands who hold or sell at profit pay no tax'
                  }
                ].map((step, index) => (
                  <div key={index} className="flex items-start gap-3 sm:gap-4">
                    <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-gradient-to-r from-[#00D9FF] to [#9D00FF] flex items-center justify-center flex-shrink-0 font-bold text-white text-sm sm:text-base">
                      {step.number}
                    </div>
                    <div>
                      <h3 className="text-[#E9E1D8] font-semibold mb-1 text-sm sm:text-base">{step.title}</h3>
                      <p className="text-[#9FA6A3] text-xs sm:text-sm leading-relaxed">{step.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="bg-[#05050A] border-t border-[#1A1A2E] mt-12 sm:mt-16 md:mt-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-10 md:py-12">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4 sm:gap-6">
            <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-6 text-xs text-[#5F6A6E]">
              <span className="font-medium text-[#9FA6A3]">IncentiveFi</span>
              <span className="w-px h-3 bg-[#2A3338]"></span>
              <span>Solana Mainnet</span>
              <span className="w-px h-3 bg-[#2A3338]"></span>
              <a href="#" className="hover:text-[#9FA6A3] transition-colors">Docs</a>
              <span className="w-px h-3 bg[#2A3338]"></span>
              <a href="#" className="hover:text-[#9FA6A3] transition-colors">GitHub</a>
            </div>
            <p className="text-xs text-[#5F6A6E] text-center">
              © 2025 IncentiveFi. Not financial advice. DYOR.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default LaunchPage;
