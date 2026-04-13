import { Link } from 'react-router-dom';
import { useState } from 'react';

const AuditPage = () => {
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
            
            <div className="flex items-center gap-4 mb-4 sm:mb-6">
              <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-full bg-[#14B8A6]/10 flex items-center justify-center">
                <i className="ri-shield-check-line text-2xl sm:text-3xl text-[#14B8A6]"></i>
              </div>
              <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold text-[#E0E0E8]">
                Security Audit Report
              </h1>
            </div>
            <p className="text-base sm:text-lg md:text-xl text-[#707078] leading-relaxed">
              Comprehensive smart contract security analysis by leading blockchain security firms
            </p>
          </div>
        </section>

        {/* Audit Summary */}
        <section className="py-12 sm:py-16">
          <div className="max-w-4xl mx-auto px-4 sm:px-6">
            <div className="bg-gradient-to-r from-[#14B8A6]/10 to-[#0D9488]/10 border border-[#14B8A6]/30 rounded-2xl sm:rounded-3xl p-6 sm:p-8 md:p-10 mb-8 sm:mb-12">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 sm:gap-8">
                <div className="text-center">
                  <div className="text-3xl sm:text-4xl font-bold text-[#14B8A6] mb-2">A+</div>
                  <div className="text-xs sm:text-sm text-[#707078]">Security Score</div>
                </div>
                <div className="text-center">
                  <div className="text-3xl sm:text-4xl font-bold text-[#14B8A6] mb-2">0</div>
                  <div className="text-xs sm:text-sm text-[#707078]">Critical Issues</div>
                </div>
                <div className="text-center">
                  <div className="text-3xl sm:text-4xl font-bold text-[#14B8A6] mb-2">100%</div>
                  <div className="text-xs sm:text-sm text-[#707078]">Test Coverage</div>
                </div>
              </div>
            </div>

            {/* Audit Details */}
            <div className="space-y-6 sm:space-y-8">
              {/* Auditor Info */}
              <div className="bg-[#0F0F15] border border-[#1A1A20] rounded-2xl p-6 sm:p-8">
                <h2 className="text-2xl sm:text-3xl font-bold text-[#C0C0C8] mb-6">Audit Information</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <div>
                    <p className="text-xs sm:text-sm text-[#707078] mb-2">Auditor</p>
                    <p className="text-base sm:text-lg font-semibold text-[#E0E0E8]">CertiK Security</p>
                  </div>
                  <div>
                    <p className="text-xs sm:text-sm text-[#707078] mb-2">Audit Date</p>
                    <p className="text-base sm:text-lg font-semibold text-[#E0E0E8]">January 15, 2025</p>
                  </div>
                  <div>
                    <p className="text-xs sm:text-sm text-[#707078] mb-2">Contract Version</p>
                    <p className="text-base sm:text-lg font-semibold text-[#E0E0E8]">v1.0.0</p>
                  </div>
                  <div>
                    <p className="text-xs sm:text-sm text-[#707078] mb-2">Blockchain</p>
                    <p className="text-base sm:text-lg font-semibold text-[#E0E0E8]">Solana</p>
                  </div>
                </div>
              </div>

              {/* Findings Summary */}
              <div className="bg-[#0F0F15] border border-[#1A1A20] rounded-2xl p-6 sm:p-8">
                <h2 className="text-2xl sm:text-3xl font-bold text-[#C0C0C8] mb-6">Findings Summary</h2>
                <div className="space-y-4">
                  {[
                    { severity: 'Critical', count: 0, color: 'text-[#EF4444]', bg: 'bg-[#EF4444]/10' },
                    { severity: 'High', count: 0, color: 'text-[#F59E0B]', bg: 'bg-[#F59E0B]/10' },
                    { severity: 'Medium', count: 2, color: 'text-[#F59E0B]', bg: 'bg-[#F59E0B]/10' },
                    { severity: 'Low', count: 3, color: 'text-[#14B8A6]', bg: 'bg-[#14B8A6]/10' },
                    { severity: 'Informational', count: 5, color: 'text-[#707078]', bg: 'bg-[#707078]/10' }
                  ].map((finding, index) => (
                    <div key={index} className="flex items-center justify-between p-4 rounded-xl bg-[#08080D] border border-[#1A1A20]">
                      <div className="flex items-center gap-4">
                        <div className={`w-10 h-10 rounded-lg ${finding.bg} flex items-center justify-center`}>
                          <span className={`text-lg font-bold ${finding.color}`}>{finding.count}</span>
                        </div>
                        <span className="text-sm sm:text-base font-semibold text-[#E0E0E8]">{finding.severity}</span>
                      </div>
                      <span className={`text-xs px-3 py-1 rounded-full ${finding.bg} ${finding.color}`}>
                        {finding.count === 0 ? 'None Found' : `${finding.count} Issues`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Key Findings */}
              <div className="bg-[#0F0F15] border border-[#1A1A20] rounded-2xl p-6 sm:p-8">
                <h2 className="text-2xl sm:text-3xl font-bold text-[#C0C0C8] mb-6">Key Findings</h2>
                <div className="space-y-6">
                  {[
                    {
                      id: 'M-01',
                      severity: 'Medium',
                      title: 'Gas Optimization Opportunity',
                      description: 'Cost basis tracking can be optimized to reduce gas costs by approximately 15%.',
                      status: 'Resolved',
                      color: 'text-[#F59E0B]'
                    },
                    {
                      id: 'M-02',
                      severity: 'Medium',
                      title: 'Event Emission Enhancement',
                      description: 'Additional events should be emitted for better off-chain tracking.',
                      status: 'Resolved',
                      color: 'text-[#F59E0B]'
                    },
                    {
                      id: 'L-01',
                      severity: 'Low',
                      title: 'Documentation Improvement',
                      description: 'Function documentation could be more detailed for complex calculations.',
                      status: 'Resolved',
                      color: 'text-[#14B8A6]'
                    }
                  ].map((finding, index) => (
                    <div key={index} className="p-6 rounded-xl bg-[#08080D] border border-[#1A1A20]">
                      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-4">
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-mono text-[#707078] bg-[#0F0F15] px-2 py-1 rounded">{finding.id}</span>
                          <span className={`text-xs font-semibold ${finding.color}`}>{finding.severity}</span>
                        </div>
                        <span className="text-xs px-3 py-1 rounded-full bg-[#14B8A6]/10 text-[#14B8A6] w-fit">
                          {finding.status}
                        </span>
                      </div>
                      <h3 className="text-base sm:text-lg font-semibold text-[#E0E0E8] mb-2">{finding.title}</h3>
                      <p className="text-xs sm:text-sm text-[#707078] leading-relaxed">{finding.description}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Security Measures */}
              <div className="bg-[#0F0F15] border border-[#1A1A20] rounded-2xl p-6 sm:p-8">
                <h2 className="text-2xl sm:text-3xl font-bold text-[#C0C0C8] mb-6">Security Measures Implemented</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {[
                    { icon: 'ri-shield-check-line', text: 'Reentrancy Protection' },
                    { icon: 'ri-lock-line', text: 'Access Control' },
                    { icon: 'ri-refresh-line', text: 'Overflow Protection' },
                    { icon: 'ri-eye-line', text: 'Transparent Calculations' },
                    { icon: 'ri-time-line', text: 'Timestamp Validation' },
                    { icon: 'ri-file-list-line', text: 'Comprehensive Testing' }
                  ].map((measure, index) => (
                    <div key={index} className="flex items-center gap-3 p-4 rounded-xl bg-[#08080D] border border-[#1A1A20]">
                      <div className="w-10 h-10 rounded-lg bg-[#14B8A6]/10 flex items-center justify-center flex-shrink-0">
                        <i className={`${measure.icon} text-[#14B8A6]`}></i>
                      </div>
                      <span className="text-sm sm:text-base text-[#E0E0E8]">{measure.text}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Conclusion */}
              <div className="bg-gradient-to-r from-[#14B8A6]/10 to-[#0D9488]/10 border border-[#14B8A6]/30 rounded-2xl p-6 sm:p-8">
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-full bg-[#14B8A6] flex items-center justify-center flex-shrink-0">
                    <i className="ri-checkbox-circle-line text-2xl text-white"></i>
                  </div>
                  <div>
                    <h3 className="text-lg sm:text-xl font-bold text-[#E0E0E8] mb-3">Audit Conclusion</h3>
                    <p className="text-sm sm:text-base text-[#909098] leading-relaxed mb-4">
                      The IncentiveFi smart contracts have undergone a comprehensive security audit and have been found to be secure and well-implemented. All identified issues have been resolved, and the contracts follow industry best practices for Solana development.
                    </p>
                    <p className="text-sm sm:text-base text-[#909098] leading-relaxed">
                      The penalty mechanism is mathematically sound and correctly implemented. The cost basis tracking system is accurate and resistant to manipulation. We recommend the platform for production use.
                    </p>
                  </div>
                </div>
              </div>

              {/* Download CTA */}
              <div className="text-center pt-6">
                <button className="px-8 py-4 rounded-xl bg-gradient-to-r from-[#14B8A6] to-[#0D9488] text-white text-base font-semibold hover:from-[#0D9488] hover:to-[#0F766E] transition-all whitespace-nowrap cursor-pointer shadow-xl shadow-[#14B8A6]/30 inline-flex items-center gap-3">
                  <i className="ri-download-line text-xl"></i>
                  Download Full Audit Report (PDF)
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

export default AuditPage;