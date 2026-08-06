import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import WalletButton from '../../components/WalletButton';
import { useWalletConnected } from '../../hooks/useWalletConnected';
import { createRealToken } from '../../lib/createToken';
import { supabase } from '../../lib/supabase';
import {
  EVM_CHAIN_NAME,
  EVM_NATIVE_SYMBOL,
  getEvmProvider,
} from '../../lib/evmNetwork';

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
    initialLiquidity: '0.1',
    initialMarketCapUsd: '2000',
  });
  const [errors, setErrors] = useState<{
    tokenName?: string;
    tokenSymbol?: string;
    description?: string;
    initialLiquidity?: string;
    initialMarketCapUsd?: string;
  }>({});
  const [imageError, setImageError] = useState('');

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleMarketCapChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Keep the value numeric while avoiding inconsistent mobile number-input validation.
    const value = e.target.value.replace(/[^0-9.]/g, '');
    setFormData(prev => ({ ...prev, initialMarketCapUsd: value }));
  };

  const handleImageFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setImageError('Choose a PNG, JPG, WEBP, or GIF image.');
      return;
    }
    if (file.size > 1_000_000) {
      setImageError('Image must be 1 MB or smaller.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setFormData(prev => ({ ...prev, imageUrl: String(reader.result || '') }));
      setImageError('');
    };
    reader.readAsDataURL(file);
  };

  const validate = () => {
    const newErrors: {
      tokenName?: string;
      tokenSymbol?: string;
      description?: string;
      initialLiquidity?: string;
      initialMarketCapUsd?: string;
    } = {};
    if (!formData.tokenName.trim()) newErrors.tokenName = 'Token name is required';
    if (!formData.tokenSymbol.trim()) newErrors.tokenSymbol = 'Token symbol is required';
    if (!formData.description.trim()) newErrors.description = 'A short token description is required';
    if (formData.tokenSymbol.length > 10) newErrors.tokenSymbol = 'Symbol must be 10 characters or less';
    if (!Number.isFinite(Number(formData.initialLiquidity)) || Number(formData.initialLiquidity) < 0.0001) {
      newErrors.initialLiquidity = 'Initial liquidity must be at least 0.0001 ETH';
    }
    if (!Number.isFinite(Number(formData.initialMarketCapUsd)) || Number(formData.initialMarketCapUsd) <= 0) {
      newErrors.initialMarketCapUsd = 'Starting market cap must be greater than $0';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    if (!connected) return alert('Connect wallet first');

    try {
      const symbol = formData.tokenSymbol.trim().toUpperCase();
      const { data: existingTokens, error: symbolCheckError } = await supabase
        .from('tokens')
        .select('id')
        .eq('symbol', symbol)
        .limit(1);

      if (symbolCheckError) {
        throw new Error(`Could not verify symbol availability: ${symbolCheckError.message}`);
      }

      if (existingTokens && existingTokens.length > 0) {
        setErrors((prev) => ({ ...prev, tokenSymbol: 'Symbol already exists' }));
        alert(`$${symbol} already exists. Choose another ticker before launching.`);
        return;
      }

      const provider = getEvmProvider();
      if (!provider) {
        throw new Error('EVM wallet not detected. Install MetaMask, Rabby, or Robinhood Wallet.');
      }

      alert(`Creating your token on ${EVM_CHAIN_NAME}. The pool will be initialized at about $${Number(formData.initialMarketCapUsd).toLocaleString()} market cap using real ${EVM_NATIVE_SYMBOL} liquidity.\n\nThis takes a few wallet approvals: deploying the contract, approving the liquidity pool, seeding it, and locking it.`);

      const result = await createRealToken(provider, formData);
      const launchResult = result as any;

      if (launchResult.liquidity) {
        alert(
          `Token deployed and liquidity locked on ${launchResult.chain || EVM_CHAIN_NAME}!\n$${symbol}\nContract: ${launchResult.mint}\nLocked position ID: ${launchResult.liquidity.tokenId}`
        );
      } else {
        alert(
          `Token deployed on ${launchResult.chain || EVM_CHAIN_NAME}, but liquidity setup failed: ${launchResult.liquidityError}\n\n$${symbol}\nContract: ${launchResult.mint}\n\nThe token contract is live - liquidity can be added later.`
        );
      }

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
          creator_address:
            launchResult.creatorAddress || provider.publicKey?.toString?.() || '',
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
        tokenSymbol: symbol,
        mintAddress: result.mint,
        chain: 'evm',
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
                src="/incentifi-logo.jpeg" 
                alt="incentifi"
                className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg"
              />
              <span className="brand-type text-lg sm:text-xl font-semibold text-[#E9E1D8] tracking-normal">incentifi</span>
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
            <h1 className="text-4xl sm:text-5xl md:text-6xl font-semibold mb-3 sm:mb-4 bg-gradient-to-r from-[#00D9FF] via-[#9D00FF] to-[#FF00E5] bg-clip-text text-transparent">
              Launch on {EVM_CHAIN_NAME}
            </h1>
            <p className="text-base sm:text-lg md:text-xl text-[#9FA6A3]">
              Deploy an EVM token contract on {EVM_CHAIN_NAME} and save the contract address for wallet import.
            </p>
            <div className="mt-4 flex justify-center">
              <span className="inline-flex items-center rounded-full border border-[#00D9FF]/30 bg-[#081b2e] px-3 py-1 text-xs text-[#9ED0FF]">
                {EVM_CHAIN_NAME} mode
              </span>
            </div>
          </div>
        </section>

        {/* Form */}
        <section className="py-8 sm:py-12 md:py-16">
          <div className="max-w-7xl mx-auto px-4 sm:px-6">
            <div className="mb-6 sm:mb-8">
              <Link 
                to="/"
                className="inline-flex items-center gap-2 text-sm text-[#9FA6A3] hover:text-[#E9E1D8] transition-colors"
              >
                <i className="ri-arrow-left-line"></i>
                Back to Home
              </Link>
            </div>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
            <form noValidate onSubmit={handleSubmit} className="min-w-0 bg-[#1A1A2E] border border-[#2A3338] rounded-2xl sm:rounded-3xl p-6 sm:p-8 md:p-10 shadow-2xl">
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
                    placeholder="e.g., Treasury Club"
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
                    Description *
                  </label>
                  <textarea
                    name="description"
                    value={formData.description}
                    onChange={handleInputChange}
                    placeholder="A short description of your token"
                    rows={4}
                    maxLength={500}
                    className="w-full px-4 sm:px-5 py-3 sm:py-4 rounded-xl bg-[#0F0F1A] border border-[#2A3338] text-[#E9E1D8] placeholder-[#5F6A6E] focus:outline-none focus:border-[#00D9FF] transition-colors resize-none text-sm sm:text-base"
                  />
                  <p className="text-xs text-[#5F6A6E] mt-2">{formData.description.length}/500 characters</p>
                  {errors.description && <p className="text-red-400 text-xs mt-1">{errors.description}</p>}
                </div>

                {/* Token image */}
                <div>
                  <label className="block text-xs sm:text-sm font-semibold text-[#E9E1D8] mb-2 sm:mb-3 uppercase tracking-wide">
                    Token Image
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-3">
                    <label className="group flex min-h-24 cursor-pointer items-center gap-3 rounded-xl border border-dashed border-[#3A4A64] bg-[#0F1624] px-4 text-sm text-[#DCE6F8] hover:border-[#53B8FF] hover:bg-[#12213A] transition-colors">
                      <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-[#16243D] text-xl text-[#7EC8FF] group-hover:text-white">
                        <i className="ri-image-add-line"></i>
                      </span>
                      <span><span className="block font-semibold">Choose image</span><span className="text-xs text-[#7D92BC]">PNG, JPG, WEBP or GIF, max 1 MB</span></span>
                      <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={handleImageFile} className="sr-only" />
                    </label>
                    <input
                      type="url"
                      name="imageUrl"
                      value={formData.imageUrl.startsWith('data:') ? '' : formData.imageUrl}
                      onChange={handleInputChange}
                      placeholder="or paste an image URL"
                      className="w-full px-4 py-3 rounded-xl bg-[#0F0F1A] border border-[#2A3338] text-[#E9E1D8] placeholder-[#5F6A6E] focus:outline-none focus:border-[#53B8FF] transition-colors text-sm"
                    />
                  </div>
                  {imageError && <p className="text-xs text-red-400 mt-2">{imageError}</p>}
                  <p className="text-xs text-[#5F6A6E] mt-2">Your selected image is shown in the launch preview. If left empty, token initials are used.</p>
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
                    <span className="text [#E9E1D8] font-semibold">18 (EVM Standard)</span>
                  </div>
                </div>

                {/* Initial Liquidity */}
                <div>
                  <label className="block text-xs sm:text-sm font-semibold text-[#E9E1D8] mb-2 sm:mb-3 uppercase tracking-wide">
                    Initial Liquidity ({EVM_NATIVE_SYMBOL})
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      name="initialLiquidity"
                      value={formData.initialLiquidity}
                      onChange={handleInputChange}
                      placeholder="0.1"
                      step="0.0001"
                      min="0.0001"
                      className="w-full px-4 sm:px-5 py-3 sm:py-4 pr-16 sm:pr-20 rounded-xl bg [#0F0F1A] border border-[#2A3338] text-[#E9E1D8] placeholder-[#5F6A6E] focus:outline-none focus:border [#00D9FF] transition-colors text-sm sm:text-base"
                    />
                    <span className="absolute right-4 sm:right-5 top-1/2 -translate-y-1/2 text [#9FA6A3] font-semibold text-sm sm:text-base">
                      {EVM_NATIVE_SYMBOL}
                    </span>
                  </div>
                  <p className="text-xs text-[#5F6A6E] mt-2">
                    Real {EVM_NATIVE_SYMBOL} is paired with the calculated portion of supply needed for your selected starting market cap. The resulting liquidity position is permanently locked.
                  </p>
                  {errors.initialLiquidity && <p className="text-xs text-red-400 mt-2">{errors.initialLiquidity}</p>}
                </div>

                <div>
                  <label className="block text-xs sm:text-sm font-semibold text-[#E9E1D8] mb-2 sm:mb-3 uppercase tracking-wide">
                    Starting Market Cap (USD)
                  </label>
                  <div className="relative">
                    <span className="absolute left-4 sm:left-5 top-1/2 -translate-y-1/2 text-[#9FA6A3] font-semibold">$</span>
                    <input
                      type="text"
                      name="initialMarketCapUsd"
                      value={formData.initialMarketCapUsd}
                      onChange={handleMarketCapChange}
                      placeholder="2000"
                      inputMode="decimal"
                      autoComplete="off"
                      className="w-full pl-8 sm:pl-10 pr-4 sm:pr-5 py-3 sm:py-4 rounded-xl bg [#0F0F1A] border border-[#2A3338] text-[#E9E1D8] placeholder-[#5F6A6E] focus:outline-none focus:border [#00D9FF] transition-colors text-sm sm:text-base"
                    />
                  </div>
                  {errors.initialMarketCapUsd && <p className="text-xs text-red-400 mt-2">{errors.initialMarketCapUsd}</p>}
                  <p className="text-xs text-[#5F6A6E] mt-2">
                    The launch price is calculated from this target and the live ETH/USD rate. It is a real pool price, not a display-only number; trading moves it from there.
                  </p>
                </div>

                {/* Incentive Mechanism Info */}
                <div className="p-4 sm:p-6 rounded-xl bg-gradient-to-r from-[#00D9FF]/10 to-[#9D00FF]/10 border border-[#00D9FF]/30">
                  <div className="flex items-start gap-3 sm:gap-4">
                    <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-gradient-to-r from-[#00D9FF] to [#9D00FF] flex items-center justify-center flex-shrink-0">
                      <i className="ri-information-line text-white text-sm sm:text-base"></i>
                    </div>
                    <div>
                      <p className="text-xs sm:text-sm font-semibold text-[#E9E1D8] mb-2">
                        Robinhood Chain EVM Deployment
                      </p>
                      <p className="text-xs text-[#9FA6A3] leading-relaxed">
                        This deploys an ERC-20 token contract on Robinhood Chain, then seeds and permanently locks a Uniswap V3 liquidity position in the same launch.
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
                <div className="text-center text-xs text-[#5F6A6E] space-y-1">
                  <p>Robinhood Chain deployment + locked liquidity</p>
                  <p>Your wallet pays network gas and the {EVM_NATIVE_SYMBOL} liquidity amount above.</p>
                </div>
              </div>
            </form>

            <aside className="lg:sticky lg:top-28">
              <div className="overflow-hidden rounded-3xl border border-[#2A3338] bg-[#10131E] shadow-2xl shadow-black/30">
                <div className="h-24 bg-[radial-gradient(circle_at_20%_0%,rgba(0,194,255,.32),transparent_48%),radial-gradient(circle_at_85%_20%,rgba(157,0,255,.3),transparent_45%)]"></div>
                <div className="px-6 pb-6 -mt-10">
                  {formData.imageUrl ? (
                    <img src={formData.imageUrl} alt="Token preview" className="h-20 w-20 rounded-2xl border-4 border-[#10131E] object-cover bg-[#0A0E17]" />
                  ) : (
                    <div className="flex h-20 w-20 items-center justify-center rounded-2xl border-4 border-[#10131E] bg-[#1A2942] text-2xl font-bold text-[#7EC8FF]">
                      {(formData.tokenSymbol || 'IF').slice(0, 3).toUpperCase()}
                    </div>
                  )}
                  <p className="mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-[#7D92BC]">Launch preview</p>
                  <h2 className="mt-1 text-2xl font-semibold text-white">{formData.tokenName || 'Your token'}</h2>
                  <p className="mt-1 text-sm text-[#8DA3CD]">${formData.tokenSymbol.toUpperCase() || 'TICKER'}</p>
                  <p className="mt-5 min-h-12 text-sm leading-6 text-[#A7B6D2]">
                    {formData.description || 'Add a clear description so traders understand what this token is about.'}
                  </p>
                </div>
                <div className="border-t border-[#26334A] px-6 py-2">
                  <div className="flex items-center justify-between border-b border-[#26334A] py-4 text-sm"><span className="text-[#8291AA]">Paired with</span><span className="font-semibold text-white">{EVM_NATIVE_SYMBOL}</span></div>
                  <div className="flex items-center justify-between border-b border-[#26334A] py-4 text-sm"><span className="text-[#8291AA]">Pool fee</span><span className="font-semibold text-white">1.00%</span></div>
                  <div className="flex items-center justify-between border-b border-[#26334A] py-4 text-sm"><span className="text-[#8291AA]">Initial liquidity</span><span className="font-semibold text-white">{formData.initialLiquidity || '0'} {EVM_NATIVE_SYMBOL}</span></div>
                  <div className="flex items-center justify-between border-b border-[#26334A] py-4 text-sm"><span className="text-[#8291AA]">Starting market cap</span><span className="font-semibold text-white">${Number(formData.initialMarketCapUsd || 0).toLocaleString()}</span></div>
                  <div className="flex items-center justify-between py-4 text-sm"><span className="text-[#8291AA]">Liquidity</span><span className="font-semibold text-emerald-300">Locked after launch</span></div>
                </div>
                <div className="mx-6 mb-6 rounded-2xl bg-[#0A0E17] p-4 text-xs leading-5 text-[#8DA3CD]">
                  Your wallet submits every transaction. Launches are irreversible once confirmed on {EVM_CHAIN_NAME}.
                </div>
              </div>
            </aside>
            </div>

            {/* How It Works Panel */}
            <div className="mt-12 sm:mt-16 p-6 sm:p-8 md:p-10 rounded-2xl sm:rounded-3xl bg-[#1A1A2E]/50 border-2 border-dashed border-[#00D9FF]/30">
              <h2 className="text-xl sm:text-2xl font-bold text-[#E9E1D8] mb-4 sm:mb-6">How Token Creation Works</h2>
              <div className="space-y-4 sm:space-y-5">
                {[
                  {
                    number: '1',
                    title: 'Contract Deployed',
                    description: 'An ERC-20 token contract is deployed on Robinhood Chain with your selected name and symbol'
                  },
                  {
                    number: '2',
                    title: 'Creator Receives Supply',
                    description: 'The connected creator wallet receives the fixed one billion token supply'
                  },
                  {
                    number: '3',
                    title: 'Contract Address Saved',
                    description: 'The created contract address is saved so wallets, explorers, and token pages can reference it'
                  },
                  {
                    number: '4',
                    title: 'Liquidity Locked',
                    description: 'The calculated portion of supply is paired with your ETH into a Uniswap V3 pool, then the position is sent to a burn address and permanently locked.'
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
              <span className="font-medium text-[#9FA6A3]">incentifi</span>
              <span className="w-px h-3 bg-[#2A3338]"></span>
              <span>{EVM_CHAIN_NAME}</span>
              <span className="w-px h-3 bg-[#2A3338]"></span>
              <a href="#" className="hover:text-[#9FA6A3] transition-colors">Docs</a>
              <span className="w-px h-3 bg[#2A3338]"></span>
              <a href="#" className="hover:text-[#9FA6A3] transition-colors">GitHub</a>
            </div>
            <p className="text-xs text-[#5F6A6E] text-center">
              © 2025 incentifi. Not financial advice. DYOR.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default LaunchPage;
