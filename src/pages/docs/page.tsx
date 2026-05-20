import { Link } from 'react-router-dom';
import {
  BookOpen,
  ChevronUp,
  Cpu,
  FileText,
  Gauge,
  Globe2,
  Grid2X2,
  HelpCircle,
  Home,
  KeyRound,
  Layers,
  Lightbulb,
  Menu,
  Monitor,
  PlugZap,
  Radio,
  Rocket,
  Search,
  Shield,
  Wallet,
  Zap,
} from 'lucide-react';

const LOGO_URL =
  'https://static.readdy.ai/image/97719340ed94173328dfb1241fbbf19e/51991647bb900b0ff0ac5e8230d485ae.png';

const navGroups = [
  {
    label: 'Getting Started',
    items: [
      { id: 'introduction', label: 'Introduction', icon: BookOpen },
      { id: 'what-is-incentifi', label: 'What is incentifi?', icon: HelpCircle },
      { id: 'why-incentifi-exists', label: 'Why incentifi Exists', icon: Lightbulb },
      { id: 'quick-start-guide', label: 'Quick Start Guide', icon: Zap, featured: true },
      { id: 'how-it-works', label: 'How It Works', icon: Cpu },
      { id: 'connect-wallet', label: 'Connect Wallet', icon: Wallet },
      { id: 'supported-wallets', label: 'Supported Wallets', icon: KeyRound },
      { id: 'network-rpc', label: 'Network & RPC', icon: Globe2 },
    ],
  },
  {
    label: 'Interface',
    items: [
      { id: 'ui-overview', label: 'UI Overview', icon: Monitor },
      { id: 'header-navigation', label: 'Header & Navigation', icon: Grid2X2 },
      { id: 'token-ticker-banner', label: 'Token Ticker Banner', icon: Radio },
      { id: 'home-page', label: 'Home Page', icon: Home },
      { id: 'mobile-experience', label: 'Mobile Experience', icon: Monitor },
      { id: 'pwa-installation', label: 'PWA Installation', icon: PlugZap },
    ],
  },
  {
    label: 'Explore',
    items: [
      { id: 'explore-tokens', label: 'Explore Tokens', icon: Search },
      { id: 'search-tokens', label: 'Search Tokens', icon: Search },
      { id: 'filter-sort', label: 'Filter & Sort', icon: Grid2X2 },
      { id: 'token-cards', label: 'Token Cards', icon: Layers },
      { id: 'watchlist', label: 'Watchlist', icon: Radio },
    ],
  },
  {
    label: 'Creator Flow',
    items: [
      { id: 'launch-page', label: 'Launch Page', icon: Rocket },
      { id: 'launch-process', label: 'Launch Process', icon: Rocket },
      { id: 'token-details', label: 'Token Details', icon: FileText },
      { id: 'token-image', label: 'Token Image', icon: Layers },
      { id: 'creation-fees', label: 'Creation Fees', icon: Gauge },
    ],
  },
  {
    label: 'Trading',
    items: [
      { id: 'token-page', label: 'Token Detail Page', icon: Layers },
      { id: 'trading-flow', label: 'Trading Flow', icon: Gauge },
      { id: 'buying-tokens', label: 'Buying Tokens', icon: Zap },
      { id: 'selling-tokens', label: 'Selling Tokens', icon: Gauge },
      { id: 'slippage-settings', label: 'Slippage Settings', icon: Cpu },
      { id: 'position-tracking', label: 'Position Tracking', icon: Monitor },
      { id: 'price-charts', label: 'Price Charts', icon: Radio },
      { id: 'share-social', label: 'Share & Social', icon: Globe2 },
    ],
  },
  {
    label: 'Mechanism',
    items: [
      { id: 'incentive-routing-overview', label: 'Incentive Routing', icon: Zap },
      { id: 'routing-calculation', label: 'Route Calculation', icon: Cpu },
      { id: 'cost-basis', label: 'Cost Basis', icon: Gauge },
      { id: 'rule-application', label: 'Rule Application', icon: Shield },
      { id: 'external-dex', label: 'External DEX Trading', icon: Globe2 },
      { id: 'treasury', label: 'Treasury', icon: KeyRound },
    ],
  },
  {
    label: 'Advanced',
    items: [
      { id: 'tokenomics', label: 'Tokenomics', icon: Layers },
      { id: 'bonding-curve', label: 'Bonding Curve', icon: Radio },
      { id: 'migration', label: 'Migration', icon: Globe2 },
      { id: 'liquidity', label: 'Liquidity', icon: Gauge },
      { id: 'profile', label: 'Profile', icon: Monitor },
      { id: 'achievements', label: 'Achievements', icon: Lightbulb },
      { id: 'security', label: 'Security', icon: KeyRound },
      { id: 'risks', label: 'Risks', icon: HelpCircle },
      { id: 'faq', label: 'FAQ', icon: HelpCircle },
      { id: 'glossary', label: 'Glossary', icon: BookOpen },
      { id: 'troubleshooting', label: 'Troubleshooting', icon: Cpu },
      { id: 'support', label: 'Support', icon: Wallet },
    ],
  },
];

const sections = [
  {
    id: 'introduction',
    title: 'Introduction',
    body: [
      'Welcome to the official incentifi documentation. incentifi is a Solana launch platform for coins with visible holder incentives, creator tools, market discovery, and wallet-powered trading flows.',
      'The core concept is simple: when a holder exits below their average entry inside the incentifi flow, incentive routing can direct part of that value to the project treasury. Upside exits keep the standard flow, so the model is clear before anyone trades.',
      'These docs explain how the platform works from first wallet connection to launch, trading, token pages, treasury logic, mobile use, and safety considerations.',
    ],
  },
  {
    id: 'what-is-incentifi',
    title: 'What is incentifi?',
    body: [
      'incentifi is a launchpad, marketplace, and token page experience built for Solana creators. It helps anyone create a coin, publish a market page, and explain the project rule in one place.',
      'The platform is designed around holder-aligned launches. That means the trading experience, docs, token cards, and modal copy all point users back to the same idea: below-entry exits can support treasury, while upside exits stay clean and simple.',
      'incentifi does not promise returns. It gives creators a clearer launch surface and gives traders more context before they act.',
    ],
  },
  {
    id: 'why-incentifi-exists',
    title: 'Why incentifi Exists',
    body: [
      'Many coin launches feel rushed, shallow, and confusing. Rules are often unclear, project links are scattered, and users trade before understanding how the launch is supposed to work.',
      'incentifi exists to make launches feel more deliberate. The market page gives users discovery tools, the token page gives them trading context, and the docs explain the rule in plain language.',
      'The goal is a stronger launch environment: clearer rules, better project identity, more treasury transparency, and fewer surprises for holders.',
    ],
  },
  {
    id: 'quick-start-guide',
    title: 'Quick Start Guide',
    body: ['Get started with incentifi in a few minutes.'],
    steps: [
      { title: 'Connect Your Wallet', body: 'Use the Select Wallet or Connect Wallet button, choose your Solana wallet, and approve the connection request.' },
      { title: 'Explore Coins', body: 'Browse the market, use search, filter by category, and open any token card to inspect the detail page.' },
      { title: 'Review the Route', body: 'Open the How modal or docs before trading so you understand how below-entry routing, treasury support, and upside exits are presented.' },
      { title: 'Create a Coin', body: 'Go to Create Coin, enter token details, add optional links, set liquidity, and approve the launch transaction.' },
      { title: 'Trade Carefully', body: 'On token pages, review the chart, market stats, position area, and wallet prompt before confirming any transaction.' },
    ],
  },
  {
    id: 'how-it-works',
    title: 'How It Works',
    body: [
      'Each coin moves through a simple product lifecycle: launch, discovery, trading, and ongoing profile visibility.',
      'During launch, the creator enters token details and connects a wallet. During discovery, the token appears in the market grid. During trading, users can review the rule, chart, token stats, and wallet prompts.',
      'The incentifi route is intentionally repeated across the interface so users are not surprised by how below-entry exits and upside exits are treated.',
    ],
  },
  {
    id: 'connect-wallet',
    title: 'Connect Wallet',
    body: [
      'Wallet connection is required for token creation and trading actions. Visitors can browse the market and read docs without connecting.',
      'When connecting, verify that you are using the intended wallet and network. Every transaction still requires explicit approval from your wallet.',
      'incentifi never asks for private keys or seed phrases. Only connect through the visible wallet button on the official site.',
    ],
  },
  {
    id: 'supported-wallets',
    title: 'Supported Wallets',
    body: [
      'incentifi is designed for common Solana wallets such as Phantom, Solflare, Backpack, Coinbase Wallet, and wallets that expose a compatible Solana provider.',
      'If your wallet is not detected, unlock the extension or mobile wallet, check browser permissions, and reload the page.',
      'Hardware wallet setups may work through a supported browser wallet, depending on the wallet provider and network settings.',
    ],
  },
  {
    id: 'network-rpc',
    title: 'Network & RPC',
    body: [
      'incentifi runs as a Solana Mainnet launch experience. RPC availability can affect wallet prompts, transaction status, and token data refreshes.',
      'If a transaction seems delayed, check your wallet first, then refresh the token page after confirmation. Network congestion or RPC throttling can delay visible updates.',
    ],
  },
  {
    id: 'ui-overview',
    title: 'UI Overview',
    body: [
      'The incentifi interface is organized around five major surfaces: fixed header navigation, the market area, token cards, token detail pages, and documentation.',
      'The header gives quick access to How, INCENTIFI market, Profile, Docs, Create Coin, and wallet connection. The main page then expands into discovery, explanation, and creator-focused sections.',
    ],
  },
  {
    id: 'header-navigation',
    title: 'Header & Navigation',
    body: [
      'The header is fixed at the top so the main actions stay available while users scroll. It uses compact icon-led buttons with incentifi wording and colors.',
      'How opens the incentifi rule modal. INCENTIFI jumps to the market. Profile jumps to the creator/profile section. Docs opens this documentation page. Create Coin opens the launch flow.',
    ],
  },
  {
    id: 'token-ticker-banner',
    title: 'Token Ticker Banner',
    body: [
      'The ticker banner summarizes the platform context with short phrases such as incentive routing, upside exits, treasury support, and market status.',
      'Its purpose is not to explain everything. It keeps the incentifi model visible while users move toward the market grid.',
    ],
  },
  {
    id: 'home-page',
    title: 'Home Page',
    body: [
      'The home page introduces incentifi, shows live platform stats, provides the Create Coin and Read Docs actions, and then opens into the launched coin market.',
      'Below the market, the page now includes additional explanation sections for creator identity, visible rules, wallet-first usage, Solana-native behavior, and rule clarity.',
    ],
  },
  {
    id: 'mobile-experience',
    title: 'Mobile Experience',
    body: [
      'incentifi is responsive for phone screens. Navigation collapses behind a compact menu, buttons remain touch-friendly, and token cards stack into a smaller grid.',
      'Use your laptop network address during development to view the site on a phone. On production, the GoDaddy/Vercel domain will serve the same responsive layout.',
    ],
  },
  {
    id: 'pwa-installation',
    title: 'PWA Installation',
    body: [
      'A future incentifi PWA can let users add the site to their home screen for a more app-like experience.',
      'When enabled, supported browsers will show install prompts or allow installation from the browser menu. iOS users typically install through Share, then Add to Home Screen.',
    ],
  },
  {
    id: 'explore-tokens',
    title: 'Explore Tokens',
    body: [
      'The Explore area is the market grid. It shows all launched coins returned by the app data source and gives users a quick way to compare symbols, names, creator addresses, market caps, and launch age.',
      'Every card links to a token detail page where the user can review the token more deeply before taking action.',
    ],
  },
  {
    id: 'search-tokens',
    title: 'Search Tokens',
    body: [
      'The search bar supports token name, symbol, and contract-style values. Search is intended to be quick and forgiving so users can narrow the grid without leaving the page.',
      'Good search experiences matter because launch platforms can become crowded quickly. Discovery should feel fast even when many coins exist.',
    ],
  },
  {
    id: 'filter-sort',
    title: 'Filter & Sort',
    body: [
      'Category filters help users browse by broad intent such as Meme, DeFi, Gaming, AI, and Utility. Sorting helps users switch between newest launches, trending behavior, and stronger market-cap signals.',
      'The current implementation keeps filters lightweight and can be expanded as more launch data becomes available.',
    ],
  },
  {
    id: 'token-cards',
    title: 'Token Cards',
    body: [
      'Token cards show image, name, symbol, creator, age, market cap, and a Trade badge. If no image is available, the card falls back to a clean symbol placeholder.',
      'Cards are intentionally compact so users can scan many launches quickly before choosing which coin to open.',
    ],
  },
  {
    id: 'watchlist',
    title: 'Watchlist',
    body: [
      'A watchlist is a natural next step for incentifi. It would let users star coins, persist favorites locally, and sort watchlisted tokens first.',
      'The docs include this section so the product has room to grow into a deeper, fuller platform experience without borrowing another project identity.',
    ],
  },
  {
    id: 'launch-page',
    title: 'Launch Page',
    body: [
      'The launch page collects token name, symbol, description, image URL, website, X, Telegram, and initial liquidity.',
      'It also explains the incentifi routing model before submission so creators understand the product promise they are attaching to their launch.',
    ],
  },
  {
    id: 'launch-process',
    title: 'Launch Process',
    steps: [
      { title: 'Navigate', body: 'Click Create Coin in the header or hero area.' },
      { title: 'Connect Wallet', body: 'Connect a supported Solana wallet before submitting the launch transaction.' },
      { title: 'Fill Details', body: 'Enter name, symbol, description, image, socials, and liquidity information.' },
      { title: 'Review', body: 'Check spelling, links, symbol, and rule explanation before confirming.' },
      { title: 'Approve', body: 'Approve the transaction in your wallet and wait for confirmation.' },
    ],
    body: ['The launch flow should be fast, but creators should still review carefully because token identity is highly visible after launch.'],
  },
  {
    id: 'token-details',
    title: 'Token Details',
    body: [
      'Token details include the visible identity of the coin: name, ticker, description, image, and project links.',
      'Clear details help users understand whether they are viewing the right coin and whether they trust the project enough to continue.',
    ],
  },
  {
    id: 'token-image',
    title: 'Token Image',
    body: [
      'Token images should be square, readable at small sizes, and visually distinct. A strong token image improves card scanning and token page recognition.',
      'If no image is provided, incentifi uses a symbol fallback so the card still looks complete.',
    ],
  },
  {
    id: 'creation-fees',
    title: 'Creation Fees',
    body: [
      'Token creation may require SOL for network fees, account creation, and any configured launch cost.',
      'Always keep enough SOL in your wallet for transaction fees and retry room. If a transaction fails, review wallet messages before trying again.',
    ],
  },
  {
    id: 'token-page',
    title: 'Token Detail Page',
    body: [
      'Each token has a focused page with token identity, top stats, price/chart area, trade panel, position information, market data, and project links.',
      'The page should make the current token and the incentifi rule obvious at a glance.',
    ],
  },
  {
    id: 'trading-flow',
    title: 'Trading Flow',
    body: [
      'The trading flow starts from discovery, moves into review, then wallet confirmation. Users should review token details, market stats, slippage, and wallet prompts before confirming.',
      'No interface can remove trading risk. incentifi focuses on clarity: users should understand what they are doing before they sign.',
    ],
  },
  {
    id: 'buying-tokens',
    title: 'Buying Tokens',
    body: [
      'Buying is the entry side of the token page. Users enter the amount they want to spend, review expected output, and confirm through their wallet.',
      'The interface should communicate fees, slippage, and market impact before the wallet prompt appears.',
    ],
  },
  {
    id: 'selling-tokens',
    title: 'Selling Tokens',
    body: [
      'Selling is where the incentive route matters most. The interface should clearly communicate whether the sale is above entry or below entry relative to the tracked position.',
      'If the contribution route applies, the expected treasury amount and user output should be shown before confirmation.',
    ],
  },
  {
    id: 'slippage-settings',
    title: 'Slippage Settings',
    body: [
      'Slippage controls the maximum price movement a user accepts during execution. Lower slippage gives tighter execution but may fail during volatility.',
      'Higher slippage can help transactions execute, but it can also lead to worse prices. Users should adjust carefully.',
    ],
  },
  {
    id: 'position-tracking',
    title: 'Position Tracking',
    body: [
      'Position tracking helps users understand token balance, average entry, realized or unrealized performance, and whether incentive routing may apply.',
      'Clear position data is central to incentifi because the rule depends on trade context, not just the current token price.',
    ],
  },
  {
    id: 'price-charts',
    title: 'Price Charts',
    body: [
      'Charts give users a visual history of market movement. incentifi uses charting to support review, not to imply any guaranteed future performance.',
      'On smaller screens, charts should remain readable and avoid pushing trade controls too far away from the token identity.',
    ],
  },
  {
    id: 'share-social',
    title: 'Share & Social',
    body: [
      'Social links and share actions help creators move attention back to the token page instead of scattering users across random links.',
      'A good share flow should include token name, symbol, market context, and a direct link to the incentifi token page.',
    ],
  },
  {
    id: 'incentive-routing-overview',
    title: 'Incentive Routing',
    body: [
      'Incentive routing is the core incentifi mechanism. If a holder exits below average entry inside the platform flow, part of the output can route to treasury.',
      'The goal is to make the treasury path transparent and give creators a project-supporting mechanism from the beginning.',
    ],
  },
  {
    id: 'routing-calculation',
    title: 'Route Calculation',
    body: [
      'A simplified calculation is: cost basis equals total SOL spent divided by tokens acquired. If the current sale is below cost basis, the contribution route may apply.',
      'If the current sale is at or above cost basis, the contribution route does not apply. Exact execution depends on the smart contract and current pool state.',
    ],
  },
  {
    id: 'cost-basis',
    title: 'Cost Basis',
    body: [
      'Cost basis is the average entry price for a wallet position. It is the reference point used to decide whether a sale is above entry or below entry.',
      'Transfers, partial sells, and multiple buys can make cost basis more complex. The UI should always explain the current state before a user confirms.',
    ],
  },
  {
    id: 'rule-application',
    title: 'Rule Application',
    body: [
      'Inside the incentifi flow, the platform can show the intended routing model and route users through the expected trading logic.',
      'Users should still read wallet prompts carefully. The final source of truth for any transaction is the instruction they sign.',
    ],
  },
  {
    id: 'external-dex',
    title: 'External DEX Trading',
    body: [
      'External DEXs use their own swap logic. If a token becomes available outside the incentifi flow, those venues may not show the same rule context.',
      'This is why the incentifi product emphasizes trading where the rule, token identity, and treasury explanation are visible together.',
    ],
  },
  {
    id: 'treasury',
    title: 'Treasury',
    body: [
      'The treasury is where routed contributions can support the project. Treasury funds may be used for ecosystem growth, liquidity support, development, community incentives, or other project-defined goals.',
      'Treasury messaging should be transparent. Users should understand why funds are collected and where the project says they go.',
    ],
  },
  {
    id: 'tokenomics',
    title: 'Tokenomics',
    body: [
      'incentifi tokenomics are centered on launch visibility, fixed token identity, market discovery, treasury support, and clear holder incentives.',
      'As the product matures, token pages can expose more tokenomics data such as supply, liquidity, pool state, fee totals, and creator settings.',
    ],
  },
  {
    id: 'bonding-curve',
    title: 'Bonding Curve',
    body: [
      'A bonding curve is a launch model where price moves according to a formula as users buy or sell. It can help with early price discovery and always-available liquidity.',
      'If bonding curve logic is enabled for a token, the UI should explain price impact, reserves, and graduation progress clearly.',
    ],
  },
  {
    id: 'migration',
    title: 'Migration',
    body: [
      'Migration is the process of moving from an early launch mechanism to a deeper liquidity venue or AMM-style pool.',
      'If migration is supported, users should see what triggers it, what changes afterward, and whether the incentifi rule remains visible in the chosen trading flow.',
    ],
  },
  {
    id: 'liquidity',
    title: 'Liquidity',
    body: [
      'Liquidity is the amount of SOL and tokens available for trading. Higher liquidity usually reduces slippage and makes markets more stable.',
      'incentifi surfaces liquidity because it is one of the fastest ways to understand how tradable a coin may be.',
    ],
  },
  {
    id: 'profile',
    title: 'Profile',
    body: [
      'The Profile area is designed to become a user and creator identity surface. It can show wallet context, created tokens, trading stats, achievements, and saved coins.',
      'Even before a full account system exists, the page structure reserves space for a deeper incentifi identity layer.',
    ],
  },
  {
    id: 'achievements',
    title: 'Achievements',
    body: [
      'Achievements can make the platform feel more alive by rewarding creation, trading, watchlisting, early participation, and responsible review behavior.',
      'If added, achievements should support the incentifi brand without encouraging reckless trading.',
    ],
  },
  {
    id: 'security',
    title: 'Security',
    body: [
      'Security starts with wallet hygiene. Never share your seed phrase, verify the domain, and read every wallet prompt before signing.',
      'On the protocol side, smart contracts should use checked math, account validation, signer checks, and clear program-derived account rules.',
    ],
  },
  {
    id: 'risks',
    title: 'Risks & Disclaimers',
    body: [
      'Crypto trading is risky. Tokens can lose value, markets can be manipulated, liquidity can be thin, and smart contracts can contain bugs.',
      'Nothing in incentifi docs is financial advice. Users should do their own research and never trade more than they can afford to lose.',
    ],
  },
  {
    id: 'faq',
    title: 'Frequently Asked Questions',
    body: [
      'Why use incentifi? Because it gives creators a clearer launch surface and gives holders a visible incentive model before they trade.',
      'Can the contribution route be avoided? The route is presented and applied inside the intended incentifi trading flow. External venues may use different swap logic.',
      'How much does it cost to create a token? Creation costs depend on network fees, account setup, and any configured platform fee shown in the launch flow.',
    ],
  },
  {
    id: 'glossary',
    title: 'Glossary',
    body: [
      'AMM: An automated market maker that prices trades using pool reserves instead of an order book.',
      'Cost Basis: The average entry price used to determine whether a position is above entry or below entry.',
      'Below-Entry Contribution: A routed contribution that may support treasury inside the incentifi flow.',
      'Treasury: A project-controlled or program-controlled destination for ecosystem support funds.',
      'Slippage: The difference between expected and executed trade price.',
    ],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    body: [
      'If a transaction fails, check wallet balance, network status, slippage settings, and whether the wallet prompt was approved.',
      'If tokens do not appear, wait for confirmation, refresh the page, and verify the transaction in your wallet or explorer.',
      'If the page looks stale, hard refresh, clear cache, or open an incognito/private tab.',
    ],
  },
  {
    id: 'support',
    title: 'Support',
    body: [
      'For support, use the official project links shown on the site or repository. Avoid unofficial links sent by strangers.',
      'When reporting an issue, include the page, wallet type, browser, transaction signature if relevant, and a short description of what happened.',
    ],
  },
];

const DocsPage = () => {
  return (
    <div className="min-h-screen overflow-x-hidden bg-[#071012] text-[#E8EEF9]">
      <header className="fixed left-0 right-0 top-0 z-50 border-b border-[#183033] bg-[#071012]/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:h-20 sm:px-6">
          <Link to="/" className="flex min-w-0 items-center gap-3">
            <img src={LOGO_URL} alt="incentifi" className="h-10 w-10 rounded-xl" />
            <div className="min-w-0">
              <div className="truncate text-base font-bold sm:text-lg">Documentation</div>
              <div className="hidden text-xs text-[#769196] sm:block">incentifi v1.0</div>
            </div>
          </Link>
          <Link to="/" className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-[#183033] px-3 py-2 text-sm font-bold text-[#8EA2A7] hover:text-white sm:px-4">
            <Home className="h-4 w-4 shrink-0" />
            <span className="hidden sm:inline">Home</span>
          </Link>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl grid-cols-1 pt-16 sm:pt-20 lg:block">
        <aside className="scrollbar-stealth border-b border-[#183033] bg-[#071012] lg:fixed lg:left-[max(0px,calc((100vw-80rem)/2))] lg:top-20 lg:h-[calc(100vh-5rem)] lg:w-80 lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <div className="p-4 sm:p-6">
            <div className="mb-4 flex items-center justify-between rounded-2xl border border-[#183033] bg-[#0B171A] px-4 py-3">
              <span className="inline-flex items-center gap-2 text-sm font-black uppercase text-[#8EA2A7]">
                <Menu className="h-4 w-4" />
                Contents
              </span>
              <ChevronUp className="h-4 w-4 text-[#587075]" />
            </div>

            <nav className="space-y-7">
              {navGroups.map((group) => (
                <div key={group.label}>
                  <div className="mb-3 px-4 text-xs font-black uppercase tracking-widest text-[#587075]">
                    {group.label}
                  </div>
                  <div className="space-y-2">
                    {group.items.map((item) => (
                      <a
                        key={item.id}
                        href={`#${item.id}`}
                        className={`flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-bold transition ${
                          item.featured
                            ? 'bg-[#14B8A6] text-[#031011]'
                            : 'text-[#8EA2A7] hover:bg-[#0B171A] hover:text-white'
                        }`}
                      >
                        <item.icon className="h-5 w-5 shrink-0" />
                        <span>{item.label}</span>
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </nav>
          </div>
        </aside>

        <main className="min-w-0 px-4 py-10 sm:px-8 sm:py-14 lg:ml-80 lg:px-12">
          <div className="mb-12 border-b border-[#183033] pb-10">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#14B8A6]/25 bg-[#14B8A6]/10 px-4 py-2 text-sm font-bold text-[#72E0D5]">
              <FileText className="h-4 w-4" />
              Developer and user guide
            </div>
            <h1 className="text-4xl font-black text-white sm:text-5xl">incentifi Documentation</h1>
            <p className="mt-5 max-w-3xl text-lg leading-8 text-[#8EA2A7]">
              Learn how incentifi launches work, how wallets connect, how the market is organized, and how each interface supports holder-aligned tokens.
            </p>
          </div>

          <div className="space-y-14">
            {sections.map((section) => (
              <section key={section.id} id={section.id} className="scroll-mt-24">
                <h2 className="text-2xl font-black text-white sm:text-3xl">{section.title}</h2>
                <div className="mt-5 space-y-4">
                  {section.body.map((paragraph) => (
                    <p key={paragraph} className="max-w-4xl text-base leading-8 text-[#8EA2A7]">
                      {paragraph}
                    </p>
                  ))}
                </div>

                {section.steps && (
                  <div className="mt-8 space-y-6">
                    {section.steps.map((step, index) => (
                      <div key={step.title} className="grid gap-4 sm:grid-cols-[72px_1fr]">
                        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#14B8A6] text-xl font-black text-[#031011]">
                          {index + 1}
                        </div>
                        <div>
                          <h3 className="text-xl font-black text-white">{step.title}</h3>
                          <p className="mt-2 max-w-3xl text-base leading-8 text-[#8EA2A7]">{step.body}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
};

export default DocsPage;
