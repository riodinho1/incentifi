import { Link } from 'react-router-dom';
import { useState } from 'react';

const WhitepaperPage = () => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="min-h-screen bg-[#0A0A0F]">
      {/* Navigation */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-[#0A0A0F] border-b border-[#1A1A20]">
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
            
            {/* Desktop Navigation */}
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

            {/* Mobile Menu Button */}
            <button 
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden w-10 h-10 flex items-center justify-center text-[#C0C0C8] hover:text-[#14B8A6] transition-colors cursor-pointer"
            >
              <i className={`${mobileMenuOpen ? 'ri-close-line' : 'ri-menu-line'} text-2xl`}></i>
            </button>
          </div>

          {/* Mobile Menu */}
          {mobileMenuOpen && (
            <div className="md:hidden py-4 border-t border-[#1A1A20]">
              <nav className="flex flex-col gap-4">
                <Link 
                  to="/" 
                  onClick={() => setMobileMenuOpen(false)}
                  className="text-[#707078] hover:text-[#14B8A6] transition-colors text-sm font-medium px-2"
                >
                  Home
                </Link>
                <Link 
                  to="/launch" 
                  onClick={() => setMobileMenuOpen(false)}
                  className="text-[#707078] hover:text-[#14B8A6] transition-colors text-sm font-medium px-2"
                >
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

      <main className="pt-20 sm:pt-24">
        {/* Hero Section */}
        <section className="relative py-12 sm:py-16 md:py-20 bg-gradient-to-b from-[#0F0F15] to-[#0A0A0F] overflow-hidden">
          <div className="absolute inset-0">
            <div className="absolute top-0 left-1/4 w-64 sm:w-96 h-64 sm:h-96 bg-[#14B8A6]/10 rounded-full blur-3xl"></div>
            <div className="absolute bottom-0 right-1/4 w-64 sm:w-96 h-64 sm:h-96 bg-[#14B8A6]/10 rounded-full blur-3xl"></div>
          </div>
          
          <div className="relative max-w-4xl mx-auto px-4 sm:px-6">
            <Link 
              to="/"
              className="inline-flex items-center gap-2 text-sm text-[#707078] hover:text-[#14B8A6] transition-colors cursor-pointer mb-6 sm:mb-8"
            >
              <i className="ri-arrow-left-line"></i>
              Back to Home
            </Link>
            
            <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold mb-4 sm:mb-6 text-[#E0E0E8]">
              IncentiveFi Whitepaper
            </h1>
            <p className="text-base sm:text-lg md:text-xl text-[#707078] leading-relaxed">
              Technical documentation and protocol overview
            </p>
          </div>
        </section>

        {/* Content Section */}
        <section className="py-12 sm:py-16 md:py-20">
          <div className="max-w-4xl mx-auto px-4 sm:px-6">
            <div className="prose prose-invert max-w-none">
              {/* Abstract */}
              <div className="mb-12 sm:mb-16">
                <h2 className="text-2xl sm:text-3xl font-bold text-[#C0C0C8] mb-4 sm:mb-6">Abstract</h2>
                <div className="bg-[#0F0F15] border border-[#1A1A20] rounded-2xl p-6 sm:p-8">
                  <p className="text-sm sm:text-base text-[#909098] leading-relaxed">
                    IncentiveFi introduces a revolutionary token launch platform that fundamentally changes how cryptocurrency tokens incentivize holder behavior. By implementing an automated penalty system for loss-making sellers and rewarding long-term holders, IncentiveFi creates sustainable token economies that discourage speculative trading and promote genuine community building.
                  </p>
                </div>
              </div>

              {/* Introduction */}
              <div className="mb-12 sm:mb-16">
                <h2 className="text-2xl sm:text-3xl font-bold text-[#C0C0C8] mb-4 sm:mb-6">1. Introduction</h2>
                <div className="space-y-4 sm:space-y-6">
                  <div className="bg-[#0F0F15] border border-[#1A1A20] rounded-2xl p-6 sm:p-8">
                    <h3 className="text-lg sm:text-xl font-semibold text-[#E0E0E8] mb-3 sm:mb-4">1.1 Problem Statement</h3>
                    <p className="text-sm sm:text-base text-[#909098] leading-relaxed mb-4">
                      Traditional token launches suffer from several critical issues:
                    </p>
                    <ul className="space-y-2 text-sm sm:text-base text-[#909098]">
                      <li className="flex items-start gap-3">
                        <i className="ri-arrow-right-s-line text-[#14B8A6] mt-1 flex-shrink-0"></i>
                        <span>Pump and dump schemes that harm retail investors</span>
                      </li>
                      <li className="flex items-start gap-3">
                        <i className="ri-arrow-right-s-line text-[#14B8A6] mt-1 flex-shrink-0"></i>
                        <span>Lack of incentives for long-term holding</span>
                      </li>
                      <li className="flex items-start gap-3">
                        <i className="ri-arrow-right-s-line text-[#14B8A6] mt-1 flex-shrink-0"></i>
                        <span>Paper hands causing price volatility</span>
                      </li>
                      <li className="flex items-start gap-3">
                        <i className="ri-arrow-right-s-line text-[#14B8A6] mt-1 flex-shrink-0"></i>
                        <span>No mechanism to reward diamond hands</span>
                      </li>
                    </ul>
                  </div>

                  <div className="bg-[#0F0F15] border border-[#1A1A20] rounded-2xl p-6 sm:p-8">
                    <h3 className="text-lg sm:text-xl font-semibold text-[#E0E0E8] mb-3 sm:mb-4">1.2 Our Solution</h3>
                    <p className="text-sm sm:text-base text-[#909098] leading-relaxed">
                      IncentiveFi implements a smart contract-based penalty system that automatically tracks each holder's cost basis and applies a 50% penalty on SOL proceeds when tokens are sold at a loss. This penalty is redirected to the project treasury, creating a sustainable funding mechanism while discouraging panic selling.
                    </p>
                  </div>
                </div>
              </div>

              {/* Technical Architecture */}
              <div className="mb-12 sm:mb-16">
                <h2 className="text-2xl sm:text-3xl font-bold text-[#C0C0C8] mb-4 sm:mb-6">2. Technical Architecture</h2>
                <div className="space-y-4 sm:space-y-6">
                  <div className="bg-[#0F0F15] border border-[#1A1A20] rounded-2xl p-6 sm:p-8">
                    <h3 className="text-lg sm:text-xl font-semibold text-[#E0E0E8] mb-3 sm:mb-4">2.1 Smart Contract Design</h3>
                    <p className="text-sm sm:text-base text-[#909098] leading-relaxed mb-4">
                      Built on Solana blockchain for high-speed, low-cost transactions. Key components include:
                    </p>
                    <div className="space-y-3">
                      <div className="flex items-start gap-3">
                        <div className="w-8 h-8 rounded-lg bg-[#14B8A6]/10 flex items-center justify-center flex-shrink-0">
                          <i className="ri-code-s-slash-line text-[#14B8A6]"></i>
                        </div>
                        <div>
                          <p className="text-sm sm:text-base font-semibold text-[#E0E0E8] mb-1">Cost Basis Tracker</p>
                          <p className="text-xs sm:text-sm text-[#707078]">Automatically records purchase price for each holder</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="w-8 h-8 rounded-lg bg-[#14B8A6]/10 flex items-center justify-center flex-shrink-0">
                          <i className="ri-shield-check-line text-[#14B8A6]"></i>
                        </div>
                        <div>
                          <p className="text-sm sm:text-base font-semibold text-[#E0E0E8] mb-1">Penalty Calculator</p>
                          <p className="text-xs sm:text-sm text-[#707078]">Determines if sale is at loss and calculates penalty</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="w-8 h-8 rounded-lg bg-[#14B8A6]/10 flex items-center justify-center flex-shrink-0">
                          <i className="ri-safe-line text-[#14B8A6]"></i>
                        </div>
                        <div>
                          <p className="text-sm sm:text-base font-semibold text-[#E0E0E8] mb-1">Treasury Manager</p>
                          <p className="text-xs sm:text-sm text-[#707078]">Collects and manages penalty funds</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="bg-[#0F0F15] border border-[#1A1A20] rounded-2xl p-6 sm:p-8">
                    <h3 className="text-lg sm:text-xl font-semibold text-[#E0E0E8] mb-3 sm:mb-4">2.2 Penalty Mechanism</h3>
                    <div className="bg-[#08080D] border border-[#1A1A20] rounded-xl p-4 sm:p-6 mb-4">
                      <code className="text-xs sm:text-sm text-[#14B8A6] font-mono">
                        if (sellPrice &lt; costBasis) &#123;<br />
                        &nbsp;&nbsp;penalty = proceeds * 0.5;<br />
                        &nbsp;&nbsp;toSeller = proceeds - penalty;<br />
                        &nbsp;&nbsp;toTreasury = penalty;<br />
                        &#125; else &#123;<br />
                        &nbsp;&nbsp;toSeller = proceeds;<br />
                        &#125;
                      </code>
                    </div>
                    <p className="text-sm sm:text-base text-[#909098] leading-relaxed">
                      The penalty only applies when tokens are sold below the holder's average purchase price, ensuring that profitable trades and long-term holders are never penalized.
                    </p>
                  </div>
                </div>
              </div>

              {/* Tokenomics */}
              <div className="mb-12 sm:mb-16">
                <h2 className="text-2xl sm:text-3xl font-bold text-[#C0C0C8] mb-4 sm:mb-6">3. Tokenomics</h2>
                <div className="bg-[#0F0F15] border border-[#1A1A20] rounded-2xl p-6 sm:p-8">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 sm:gap-8">
                    <div>
                      <h3 className="text-lg sm:text-xl font-semibold text-[#E0E0E8] mb-4">Token Distribution</h3>
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm sm:text-base text-[#707078]">Total Supply</span>
                          <span className="text-sm sm:text-base font-semibold text-[#14B8A6]">1,000,000,000</span>
                        </div>
                        <div className="h-px bg-[#1A1A20]"></div>
                        <div className="flex items-center justify-between">
                          <span className="text-sm sm:text-base text-[#707078]">Platform Pool</span>
                          <span className="text-sm sm:text-base font-semibold text-[#14B8A6]">80%</span>
                        </div>
                        <div className="h-px bg-[#1A1A20]"></div>
                        <div className="flex items-center justify-between">
                          <span className="text-sm sm:text-base text-[#707078]">Creator Allocation</span>
                          <span className="text-sm sm:text-base font-semibold text-[#14B8A6]">20%</span>
                        </div>
                      </div>
                    </div>
                    <div>
                      <h3 className="text-lg sm:text-xl font-semibold text-[#E0E0E8] mb-4">Fee Structure</h3>
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm sm:text-base text-[#707078]">Profit Sales</span>
                          <span className="text-sm sm:text-base font-semibold text-[#14B8A6]">0%</span>
                        </div>
                        <div className="h-px bg-[#1A1A20]"></div>
                        <div className="flex items-center justify-between">
                          <span className="text-sm sm:text-base text-[#707078]">Loss Sales</span>
                          <span className="text-sm sm:text-base font-semibold text-[#EF4444]">50%</span>
                        </div>
                        <div className="h-px bg-[#1A1A20]"></div>
                        <div className="flex items-center justify-between">
                          <span className="text-sm sm:text-base text-[#707078]">Platform Fee</span>
                          <span className="text-sm sm:text-base font-semibold text-[#14B8A6]">1 SOL</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Use Cases */}
              <div className="mb-12 sm:mb-16">
                <h2 className="text-2xl sm:text-3xl font-bold text-[#C0C0C8] mb-4 sm:mb-6">4. Use Cases</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
                  {[
                    {
                      icon: 'ri-community-line',
                      title: 'Community Tokens',
                      description: 'Build loyal communities with aligned incentives'
                    },
                    {
                      icon: 'ri-game-line',
                      title: 'Gaming Projects',
                      description: 'Reward long-term players and discourage flippers'
                    },
                    {
                      icon: 'ri-palette-line',
                      title: 'NFT Collections',
                      description: 'Create sustainable economies for digital art'
                    },
                    {
                      icon: 'ri-funds-line',
                      title: 'DeFi Protocols',
                      description: 'Incentivize liquidity providers and stakers'
                    }
                  ].map((useCase, index) => (
                    <div key={index} className="bg-[#0F0F15] border border-[#1A1A20] rounded-2xl p-6 hover:border-[#14B8A6]/30 transition-all">
                      <div className="w-12 h-12 rounded-xl bg-[#14B8A6]/10 flex items-center justify-center mb-4">
                        <i className={`${useCase.icon} text-2xl text-[#14B8A6]`}></i>
                      </div>
                      <h3 className="text-base sm:text-lg font-semibold text-[#E0E0E8] mb-2">{useCase.title}</h3>
                      <p className="text-xs sm:text-sm text-[#707078]">{useCase.description}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Roadmap */}
              <div className="mb-12 sm:mb-16">
                <h2 className="text-2xl sm:text-3xl font-bold text-[#C0C0C8] mb-4 sm:mb-6">5. Roadmap</h2>
                <div className="space-y-4">
                  {[
                    { phase: 'Q1 2025', title: 'Platform Launch', status: 'completed' },
                    { phase: 'Q2 2025', title: 'Multi-chain Support', status: 'in-progress' },
                    { phase: 'Q3 2025', title: 'Advanced Analytics Dashboard', status: 'planned' },
                    { phase: 'Q4 2025', title: 'DAO Governance', status: 'planned' }
                  ].map((item, index) => (
                    <div key={index} className="bg-[#0F0F15] border border-[#1A1A20] rounded-2xl p-6 sm:p-8 flex items-center gap-4 sm:gap-6">
                      <div className={`w-3 h-3 rounded-full flex-shrink-0 ${
                        item.status === 'completed' ? 'bg-[#14B8A6]' : 
                        item.status === 'in-progress' ? 'bg-[#F59E0B]' : 
                        'bg-[#707078]'
                      }`}></div>
                      <div className="flex-1">
                        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                          <span className="text-xs sm:text-sm font-semibold text-[#14B8A6]">{item.phase}</span>
                          <span className="text-base sm:text-lg font-semibold text-[#E0E0E8]">{item.title}</span>
                        </div>
                      </div>
                      <span className={`text-xs px-3 py-1 rounded-full ${
                        item.status === 'completed' ? 'bg-[#14B8A6]/10 text-[#14B8A6]' : 
                        item.status === 'in-progress' ? 'bg-[#F59E0B]/10 text-[#F59E0B]' : 
                        'bg-[#707078]/10 text-[#707078]'
                      }`}>
                        {item.status === 'completed' ? 'Done' : item.status === 'in-progress' ? 'Active' : 'Planned'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Conclusion */}
              <div className="mb-12 sm:mb-16">
                <h2 className="text-2xl sm:text-3xl font-bold text-[#C0C0C8] mb-4 sm:mb-6">6. Conclusion</h2>
                <div className="bg-gradient-to-r from-[#14B8A6]/10 to-[#0D9488]/10 border border-[#14B8A6]/30 rounded-2xl p-6 sm:p-8">
                  <p className="text-sm sm:text-base text-[#909098] leading-relaxed">
                    IncentiveFi represents a paradigm shift in token economics by aligning the interests of creators, long-term holders, and the broader community. By penalizing short-term speculation and rewarding conviction, we create sustainable token economies that can thrive in any market condition. Our platform empowers creators to launch tokens with built-in mechanisms that protect their communities and reward loyalty.
                  </p>
                </div>
              </div>

              {/* Download CTA */}
              <div className="text-center">
                <button className="px-8 py-4 rounded-xl bg-gradient-to-r from-[#14B8A6] to-[#0D9488] text-white text-base font-semibold hover:from-[#0D9488] hover:to-[#0F766E] transition-all whitespace-nowrap cursor-pointer shadow-xl shadow-[#14B8A6]/30 inline-flex items-center gap-3">
                  <i className="ri-download-line text-xl"></i>
                  Download Full Whitepaper (PDF)
                </button>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="bg-[#05050A] border-t border-[#0F0F15]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-10 md:py-12">
          <div className="text-center">
            <p className="text-xs sm:text-sm text-[#606068]">
              © 2025 IncentiveFi. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default WhitepaperPage;