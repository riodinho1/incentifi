import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import WalletButton from '../../components/WalletButton';
import { useWalletConnected } from '../../hooks/useWalletConnected';
import { createRealToken } from '../../lib/createToken';
import { supabase, isSupabaseConfigured } from '../../lib/supabase';
import { normalizeSymbol, verifySymbolAvailability } from '../../lib/symbolRegistry';
import {
  EVM_CHAIN_NAME,
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
  });
  const [errors, setErrors] = useState<{
    tokenName?: string;
    tokenSymbol?: string;
    description?: string;
  }>({});
  const [imageError, setImageError] = useState('');
  const [isDeploying, setIsDeploying] = useState(false);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
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
    } = {};
    if (!formData.tokenName.trim()) newErrors.tokenName = 'Token name is required';
    if (!formData.tokenSymbol.trim()) newErrors.tokenSymbol = 'Token symbol is required';
    if (!formData.description.trim()) newErrors.description = 'A short token description is required';
    if (formData.tokenSymbol.length > 10) newErrors.tokenSymbol = 'Symbol must be 10 characters or less';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const [deployStep, setDeployStep] = useState<{
    step: number;
    total: number;
    title: string;
    desc: string;
  } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    if (!connected) return alert('Connect wallet first');

    try {
      setIsDeploying(true);
      setDeployStep({
        step: 1,
        total: 3,
        title: 'Deploying ERC-20 Token Contract',
        desc: 'Sign the token creation transaction in your wallet...',
      });
      const symbol = normalizeSymbol(formData.tokenSymbol);
      
      const symbolCheck = await verifySymbolAvailability(symbol);
      if (!symbolCheck.isAvailable) {
        setErrors((prev) => ({ ...prev, tokenSymbol: symbolCheck.error || 'Symbol unavailable' }));
        alert(symbolCheck.error || `Could not verify availability for $${symbol}. Deployment stopped.`);
        setIsDeploying(false);
        setDeployStep(null);
        return;
      }

      const provider = getEvmProvider();
      if (!provider) {
        throw new Error('EVM wallet not detected. Install MetaMask, Rabby, or Robinhood Wallet.');
      }

      const result = await createRealToken(provider, {
        ...formData,
        tokenSymbol: symbol,
        onProgress: (step, total, title, desc) => {
          setDeployStep({ step, total, title, desc });
        },
      });
      const launchResult = result as any;

      alert(
        `Token and Incentifi Bonding Curve deployed successfully on ${launchResult.chain || EVM_CHAIN_NAME}!\n\n$${symbol}\nToken Contract: ${launchResult.mint}\nBonding Curve: ${launchResult.curveAddress || 'Active'}`
      );

      // Save token to Supabase registry if configured
      if (isSupabaseConfigured()) {
        try {
          const { error } = await supabase.from('tokens').insert({
            name: formData.tokenName,
            symbol: symbol,
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
        } catch (err: unknown) {
          console.error('Supabase save error:', err);
          const message = err instanceof Error ? err.message : 'Unknown Supabase error';
          alert(`Token deployed on-chain (${result.mint}), but registry save encountered an issue: ${message}`);
        }
      }

      // Save data for preview
      const tokenData = {
        ...formData,
        tokenSymbol: symbol,
        mintAddress: result.mint,
        curveAddress: launchResult.curveAddress || undefined,
        chain: 'evm',
      };
      localStorage.setItem('previewToken', JSON.stringify(tokenData));

      navigate(`/token-preview/${tokenData.tokenSymbol}`);
    } catch (err: any) {
      console.error('Token creation error:', err);
      alert('Failed to create token: ' + (err.message || 'Unknown error. Check console for details.'));
    } finally {
      setIsDeploying(false);
      setDeployStep(null);
    }
  };

  return (
    <div className="min-h-screen bg-[#070A12] text-slate-100 font-sans selection:bg-[#10B981]/30 selection:text-white">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 border-b border-[#1E293B] bg-[#070A12]/90 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16 sm:h-20">
            <Link to="/" className="flex items-center gap-3 hover:opacity-90 transition-opacity">
              <img 
                src="/incentifi-logo.jpeg" 
                alt="incentifi"
                className="w-9 h-9 rounded-xl border border-[#1E293B] shadow-md shadow-emerald-950/20"
              />
              <div className="flex flex-col">
                <span className="text-xl font-bold tracking-tight text-white flex items-center gap-1.5">
                  incentifi
                  <span className="w-1.5 h-1.5 rounded-full bg-[#10B981]"></span>
                </span>
                <span className="text-[10px] text-slate-400 font-medium tracking-wide uppercase">{EVM_CHAIN_NAME}</span>
              </div>
            </Link>
            
            <nav className="hidden md:flex items-center gap-8">
              <Link to="/" className="text-slate-400 hover:text-white transition-colors text-sm font-medium">
                Home
              </Link>
              <Link to="/launch" className="text-[#10B981] font-semibold text-sm flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] animate-pulse"></span>
                Launch Token
              </Link>
              <Link to="/docs" className="text-slate-400 hover:text-white transition-colors text-sm font-medium">
                Docs
              </Link>
              <div className="h-4 w-px bg-[#1E293B]" />
              <WalletButton />
            </nav>

            {/* Mobile menu button */}
            <button 
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden w-10 h-10 flex items-center justify-center rounded-xl bg-[#0D1322] border border-[#1E293B] text-slate-300 hover:text-white transition-colors"
            >
              <i className={`${mobileMenuOpen ? 'ri-close-line' : 'ri-menu-line'} text-xl`}></i>
            </button>
          </div>

          {/* Mobile menu */}
          {mobileMenuOpen && (
            <div className="md:hidden py-4 border-t border-[#1E293B] bg-[#070A12]/95 backdrop-blur-xl">
              <nav className="flex flex-col gap-3">
                <Link 
                  to="/" 
                  onClick={() => setMobileMenuOpen(false)}
                  className="text-slate-400 hover:text-white transition-colors text-sm font-medium px-3 py-2 rounded-lg hover:bg-[#0D1322]"
                >
                  Home
                </Link>
                <Link 
                  to="/launch" 
                  onClick={() => setMobileMenuOpen(false)}
                  className="text-[#10B981] font-semibold text-sm px-3 py-2 rounded-lg bg-[#10B981]/10 border border-[#10B981]/20"
                >
                  Launch Token
                </Link>
                <Link 
                  to="/docs" 
                  onClick={() => setMobileMenuOpen(false)}
                  className="text-slate-400 hover:text-white transition-colors text-sm font-medium px-3 py-2 rounded-lg hover:bg-[#0D1322]"
                >
                  Docs
                </Link>
                <div className="pt-2">
                  <WalletButton />
                </div>
              </nav>
            </div>
          )}
        </div>
      </header>

      <main className="pt-20 sm:pt-24 pb-16 sm:pb-24">
        {/* Hero Section */}
        <section className="relative border-b border-[#1E293B]/80 bg-gradient-to-b from-[#0D1322]/80 via-[#070A12] to-[#070A12] py-10 sm:py-14">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-[#10B981]/10 text-[#10B981] border border-[#10B981]/20">
                <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] animate-pulse"></span>
                {EVM_CHAIN_NAME} Launchpad
              </span>
              <span className="text-xs text-slate-500 font-mono">1B Fixed Supply · Loss Protection</span>
            </div>
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black tracking-tight text-white">
              Launch Your Token
            </h1>
            <p className="mt-2.5 max-w-2xl text-sm sm:text-base text-slate-400 leading-relaxed">
              Deploy a standard ERC-20 token contract with built-in Incentifi Router trading and automated 10% 5-minute loss-reward protection.
            </p>
          </div>
        </section>

        {/* Launch Workspace */}
        <section className="py-8 sm:py-12">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="mb-6 flex items-center justify-between">
              <Link 
                to="/"
                className="inline-flex items-center gap-2 text-xs sm:text-sm font-medium text-slate-400 hover:text-white transition-colors"
              >
                <i className="ri-arrow-left-line"></i>
                Back to Markets
              </Link>

              <div className="hidden sm:flex items-center gap-2 text-xs text-slate-400">
                <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                Network: <span className="text-slate-200 font-medium">{EVM_CHAIN_NAME}</span>
              </div>
            </div>

            {/* Main Form & Preview Grid */}
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.85fr)] items-start">
              
              {/* Form Column */}
              <form noValidate onSubmit={handleSubmit} className="bg-[#0D1322]/90 border border-[#1E293B] rounded-2xl sm:rounded-3xl p-6 sm:p-8 lg:p-10 shadow-xl shadow-black/40 backdrop-blur-xl space-y-6 sm:space-y-8">
                
                {/* Wallet Status Banner */}
                {!connected && (
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 rounded-xl border border-amber-500/20 bg-amber-500/10 text-amber-300">
                    <div className="flex items-center gap-3 text-xs sm:text-sm font-medium">
                      <i className="ri-wallet-3-line text-lg flex-shrink-0"></i>
                      <span>Connect your wallet to deploy on {EVM_CHAIN_NAME}.</span>
                    </div>
                    <WalletButton />
                  </div>
                )}

                {/* Section 1: Token Identity */}
                <div className="space-y-5">
                  <div className="flex items-center gap-2 border-b border-[#1E293B] pb-3">
                    <span className="w-6 h-6 rounded-lg bg-[#10B981]/10 text-[#10B981] flex items-center justify-center text-xs font-bold font-mono">1</span>
                    <h2 className="text-sm sm:text-base font-bold text-white uppercase tracking-wider">Token Identity</h2>
                  </div>

                  <div className="grid gap-5 sm:grid-cols-2">
                    {/* Token Name */}
                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">
                        Token Name *
                      </label>
                      <input
                        type="text"
                        name="tokenName"
                        value={formData.tokenName}
                        onChange={handleInputChange}
                        placeholder="e.g., Treasury Club"
                        maxLength={32}
                        className="w-full px-4 py-3 rounded-xl bg-[#0A0F1D] border border-[#1E293B] text-white placeholder-slate-600 focus:outline-none focus:border-[#10B981] transition-colors text-sm font-medium"
                      />
                      <div className="flex justify-between items-center mt-1.5 text-[11px] text-slate-500">
                        <span>{formData.tokenName.length}/32 chars</span>
                        {errors.tokenName && <span className="text-rose-400 font-medium">{errors.tokenName}</span>}
                      </div>
                    </div>

                    {/* Token Symbol */}
                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">
                        Ticker Symbol *
                      </label>
                      <input
                        type="text"
                        name="tokenSymbol"
                        value={formData.tokenSymbol}
                        onChange={handleInputChange}
                        placeholder="e.g., DHT"
                        maxLength={10}
                        className="w-full px-4 py-3 rounded-xl bg-[#0A0F1D] border border-[#1E293B] text-white placeholder-slate-600 focus:outline-none focus:border-[#10B981] transition-colors uppercase font-mono text-sm font-bold tracking-wide"
                      />
                      <div className="flex justify-between items-center mt-1.5 text-[11px] text-slate-500">
                        <span>{formData.tokenSymbol.length}/10 chars</span>
                        {errors.tokenSymbol && <span className="text-rose-400 font-medium">{errors.tokenSymbol}</span>}
                      </div>
                    </div>
                  </div>

                  {/* Description */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">
                      Description *
                    </label>
                    <textarea
                      name="description"
                      value={formData.description}
                      onChange={handleInputChange}
                      placeholder="Explain your token's utility, thesis, or community roadmap..."
                      rows={3}
                      maxLength={500}
                      className="w-full px-4 py-3 rounded-xl bg-[#0A0F1D] border border-[#1E293B] text-white placeholder-slate-600 focus:outline-none focus:border-[#10B981] transition-colors resize-none text-sm font-medium leading-relaxed"
                    />
                    <div className="flex justify-between items-center mt-1.5 text-[11px] text-slate-500">
                      <span>{formData.description.length}/500 chars</span>
                      {errors.description && <span className="text-rose-400 font-medium">{errors.description}</span>}
                    </div>
                  </div>
                </div>

                {/* Section 2: Branding & Media */}
                <div className="space-y-5">
                  <div className="flex items-center gap-2 border-b border-[#1E293B] pb-3">
                    <span className="w-6 h-6 rounded-lg bg-[#10B981]/10 text-[#10B981] flex items-center justify-center text-xs font-bold font-mono">2</span>
                    <h2 className="text-sm sm:text-base font-bold text-white uppercase tracking-wider">Token Icon & Links</h2>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">
                      Token Logo (Optional)
                    </label>
                    <div className="grid grid-cols-1 gap-3">
                      <label className="group flex items-center gap-4 p-4 rounded-xl border border-dashed border-[#1E293B] bg-[#0A0F1D] hover:border-[#10B981] hover:bg-[#10B981]/5 transition-all cursor-pointer">
                        <div className="w-12 h-12 rounded-xl bg-[#070A12] border border-[#1E293B] flex items-center justify-center text-slate-400 group-hover:text-[#10B981] transition-colors flex-shrink-0">
                          <i className="ri-image-add-line text-xl"></i>
                        </div>
                        <div className="min-w-0 flex-1">
                          <span className="block text-xs font-semibold text-white">Upload image from device</span>
                          <span className="text-[11px] text-slate-500">PNG, JPG, WEBP or GIF (Max 1 MB)</span>
                        </div>
                        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={handleImageFile} className="sr-only" />
                      </label>
                      <input
                        type="url"
                        name="imageUrl"
                        value={formData.imageUrl.startsWith('data:') ? '' : formData.imageUrl}
                        onChange={handleInputChange}
                        placeholder="or paste external image URL (https://...)"
                        className="w-full px-4 py-2.5 rounded-xl bg-[#0A0F1D] border border-[#1E293B] text-white placeholder-slate-600 focus:outline-none focus:border-[#10B981] transition-colors text-xs font-medium"
                      />
                    </div>
                    {imageError && <p className="text-xs text-rose-400 mt-1.5 font-medium">{imageError}</p>}
                  </div>

                  {/* Social Links */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-400 mb-1.5 uppercase">Website</label>
                      <div className="relative">
                        <i className="ri-global-line absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs"></i>
                        <input
                          type="url"
                          name="website"
                          value={formData.website}
                          onChange={handleInputChange}
                          placeholder="https://..."
                          className="w-full pl-8 pr-3 py-2 rounded-xl bg-[#0A0F1D] border border-[#1E293B] text-white placeholder-slate-600 focus:outline-none focus:border-[#10B981] transition-colors text-xs font-medium"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-400 mb-1.5 uppercase">X / Twitter</label>
                      <div className="relative">
                        <i className="ri-twitter-x-line absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs"></i>
                        <input
                          type="url"
                          name="twitter"
                          value={formData.twitter}
                          onChange={handleInputChange}
                          placeholder="https://x.com/..."
                          className="w-full pl-8 pr-3 py-2 rounded-xl bg-[#0A0F1D] border border-[#1E293B] text-white placeholder-slate-600 focus:outline-none focus:border-[#10B981] transition-colors text-xs font-medium"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-400 mb-1.5 uppercase">Telegram</label>
                      <div className="relative">
                        <i className="ri-telegram-line absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs"></i>
                        <input
                          type="url"
                          name="telegram"
                          value={formData.telegram}
                          onChange={handleInputChange}
                          placeholder="https://t.me/..."
                          className="w-full pl-8 pr-3 py-2 rounded-xl bg-[#0A0F1D] border border-[#1E293B] text-white placeholder-slate-600 focus:outline-none focus:border-[#10B981] transition-colors text-xs font-medium"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Section 3: Economics & Incentives Notice */}
                <div className="space-y-4">
                  <div className="flex items-center gap-2 border-b border-[#1E293B] pb-3">
                    <span className="w-6 h-6 rounded-lg bg-[#10B981]/10 text-[#10B981] flex items-center justify-center text-xs font-bold font-mono">3</span>
                    <h2 className="text-sm sm:text-base font-bold text-white uppercase tracking-wider">Economics & Incentives</h2>
                  </div>

                  <div className="grid grid-cols-2 gap-3 p-4 rounded-xl bg-[#0A0F1D] border border-[#1E293B]">
                    <div>
                      <span className="block text-[11px] text-slate-400 uppercase">Total Supply</span>
                      <span className="text-sm font-bold text-white font-mono">1,000,000,000</span>
                    </div>
                    <div>
                      <span className="block text-[11px] text-slate-400 uppercase">Token Standard</span>
                      <span className="text-sm font-bold text-white font-mono">ERC-20 (18 Dec)</span>
                    </div>
                  </div>

                  <div className="p-4 rounded-xl bg-gradient-to-br from-[#10B981]/10 via-[#0D1322] to-[#070A12] border border-[#10B981]/30">
                    <div className="flex items-start gap-3">
                      <div className="w-8 h-8 rounded-lg bg-[#10B981]/20 border border-[#10B981]/40 flex items-center justify-center flex-shrink-0 text-[#10B981]">
                        <i className="ri-shield-check-line text-base"></i>
                      </div>
                      <div className="space-y-1">
                        <h3 className="text-xs font-bold text-white flex items-center gap-2">
                          10% 5-Minute Loss-Reward Protection & 2% Trading Fee
                        </h3>
                        <p className="text-[11px] text-slate-300 leading-relaxed">
                          All trades route through the Incentifi Router with a 2.0% fee (1.0% directly to creator wallet, 1.0% deposited into the token's Loss Reward Pool). Eligible underwater holders receive 10% 5-minute loss-reward distributions in native ETH.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Submit Action */}
                <div className="space-y-3 pt-2">
                  {isDeploying && deployStep && (
                    <div className="p-4 rounded-xl bg-[#081524] border border-[#10B981]/40 shadow-lg space-y-2">
                      <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-[#10B981]">
                        <span className="flex items-center gap-1.5">
                          <i className="ri-loader-4-line animate-spin"></i>
                          Step {deployStep.step} of {deployStep.total}
                        </span>
                        <span>{deployStep.title}</span>
                      </div>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        {deployStep.desc}
                      </p>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={!connected || isDeploying}
                    className={`w-full py-4 rounded-xl text-white text-base font-bold transition-all shadow-lg flex items-center justify-center gap-2 ${
                      connected && !isDeploying
                        ? 'bg-gradient-to-r from-[#10B981] to-[#059669] hover:from-[#059669] hover:to-[#047857] shadow-[#10B981]/25 hover:shadow-xl hover:shadow-[#10B981]/30 cursor-pointer active:scale-[0.99]'
                        : 'bg-slate-800 text-slate-400 opacity-60 cursor-not-allowed border border-slate-700'
                    }`}
                  >
                    {isDeploying ? (
                      <>
                        <i className="ri-loader-4-line animate-spin text-lg"></i>
                        <span>
                          {deployStep ? `Step ${deployStep.step}/${deployStep.total}: ${deployStep.title}` : `Deploying on ${EVM_CHAIN_NAME}...`}
                        </span>
                      </>
                    ) : connected ? (
                      <>
                        <i className="ri-rocket-line text-lg"></i>
                        <span>Deploy Token & Bonding Curve</span>
                      </>
                    ) : (
                      <>
                        <i className="ri-wallet-3-line text-lg"></i>
                        <span>Connect Wallet First</span>
                      </>
                    )}
                  </button>

                  <p className="text-center text-[11px] text-slate-500">
                    Your wallet will prompt for signature and standard network gas on {EVM_CHAIN_NAME}.
                  </p>
                </div>
              </form>

              {/* Live Preview Card Column */}
              <aside className="lg:sticky lg:top-28 space-y-6">
                <div className="bg-[#0D1322]/90 border border-[#1E293B] rounded-2xl sm:rounded-3xl p-6 shadow-xl shadow-black/30 backdrop-blur-xl">
                  <div className="flex items-center justify-between border-b border-[#1E293B] pb-4 mb-5">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                      <i className="ri-eye-line text-[#10B981]"></i>
                      Live Token Preview
                    </span>
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#10B981]/10 text-[#10B981] border border-[#10B981]/20">
                      Draft
                    </span>
                  </div>

                  <div className="flex items-start gap-4 mb-5">
                    {formData.imageUrl ? (
                      <img 
                        src={formData.imageUrl} 
                        alt="Token avatar" 
                        className="w-16 h-16 rounded-2xl object-cover bg-[#070A12] border border-[#1E293B]" 
                      />
                    ) : (
                      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#10B981]/20 via-[#0D1322] to-[#070A12] border border-[#10B981]/30 flex items-center justify-center text-xl font-black text-[#10B981] font-mono shadow-inner">
                        {(formData.tokenSymbol || 'DHT').slice(0, 3).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <h3 className="text-xl font-bold text-white truncate">
                        {formData.tokenName || 'Your Token Name'}
                      </h3>
                      <span className="inline-block mt-0.5 text-xs font-bold font-mono text-[#10B981] uppercase tracking-wide">
                        ${(formData.tokenSymbol || 'DHT').toUpperCase()}
                      </span>
                      <div className="mt-1 flex items-center gap-2">
                        <span className="text-[10px] text-slate-400 font-medium px-2 py-0.5 rounded bg-[#070A12] border border-[#1E293B]">
                          {EVM_CHAIN_NAME}
                        </span>
                      </div>
                    </div>
                  </div>

                  <p className="text-xs text-slate-400 line-clamp-3 leading-relaxed mb-5 bg-[#070A12] p-3 rounded-xl border border-[#1E293B]">
                    {formData.description || 'Token description will appear here on your token preview and trading terminal.'}
                  </p>

                  <div className="space-y-2.5 border-t border-[#1E293B] pt-4 text-xs">
                    <div className="flex items-center justify-between text-slate-400">
                      <span>Network</span>
                      <span className="text-white font-medium">{EVM_CHAIN_NAME}</span>
                    </div>
                    <div className="flex items-center justify-between text-slate-400">
                      <span>Supply</span>
                      <span className="text-white font-mono font-medium">1,000,000,000</span>
                    </div>
                    <div className="flex items-center justify-between text-slate-400">
                      <span>Decimals</span>
                      <span className="text-white font-mono font-medium">18 (Standard)</span>
                    </div>
                    <div className="flex items-center justify-between text-slate-400">
                      <span>Router Fee</span>
                      <span className="text-[#10B981] font-medium">2.0% (1% Creator / 1% Loss Pool)</span>
                    </div>
                    <div className="flex items-center justify-between text-slate-400">
                      <span>Protection</span>
                      <span className="text-emerald-400 font-medium">10% / 5-Min Loss Pool</span>
                    </div>
                  </div>
                </div>

                {/* Quick Process Steps */}
                <div className="bg-[#0D1322]/60 border border-[#1E293B]/70 rounded-2xl p-5 space-y-3">
                  <h4 className="text-xs font-bold text-white uppercase tracking-wider">Launch Sequence</h4>
                  <div className="space-y-2.5 text-xs text-slate-400">
                    <div className="flex items-start gap-2.5">
                      <span className="w-5 h-5 rounded-full bg-[#10B981]/10 text-[#10B981] flex items-center justify-center font-bold font-mono text-[10px] flex-shrink-0 mt-0.5">1</span>
                      <span>Deploy ERC-20 contract with fixed 1B supply.</span>
                    </div>
                    <div className="flex items-start gap-2.5">
                      <span className="w-5 h-5 rounded-full bg-[#10B981]/10 text-[#10B981] flex items-center justify-center font-bold font-mono text-[10px] flex-shrink-0 mt-0.5">2</span>
                      <span>Seed Uniswap V3 liquidity pool and lock LP.</span>
                    </div>
                    <div className="flex items-start gap-2.5">
                      <span className="w-5 h-5 rounded-full bg-[#10B981]/10 text-[#10B981] flex items-center justify-center font-bold font-mono text-[10px] flex-shrink-0 mt-0.5">3</span>
                      <span>Trade on Incentifi with Loss-Reward protection.</span>
                    </div>
                  </div>
                </div>
              </aside>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="bg-[#05070D] border-t border-[#1E293B] py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span className="font-semibold text-slate-300">incentifi</span>
              <span>·</span>
              <span>{EVM_CHAIN_NAME}</span>
              <span>·</span>
              <Link to="/docs" className="hover:text-slate-300 transition-colors">Documentation</Link>
            </div>
            <p className="text-xs text-slate-500">
              © {new Date().getFullYear()} Incentifi. Verified on Robinhood Chain.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default LaunchPage;

