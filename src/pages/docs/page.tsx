import { Link } from 'react-router-dom';
import { useState } from 'react';
import {
  BookOpen,
  ChevronDown,
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
  '/incentifi-logo.jpeg';

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
      { id: 'treasury', label: 'Treasury & Loss Pool', icon: KeyRound },
    ],
  },
  {
    label: 'Advanced',
    items: [
      { id: 'tokenomics', label: 'Tokenomics', icon: Layers },
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
      'Welcome to the official incentifi documentation. incentifi is a Robinhood Chain EVM launch platform for tokens with visible holder incentives, creator tools, market discovery, and wallet-powered trading flows.',
      'The core concept is simple: all trading routes through the Incentifi Router with a 1.0% fee split (0.5% to the token creator in native ETH and 0.5% deposited into the Loss Reward Pool). Eligible underwater holders receive hourly 10% loss-reward distributions in native ETH.',
      'These docs explain how the platform works from first wallet connection to launch, trading, token pages, fee routing logic, mobile use, and safety considerations.',
    ],
  },
  {
    id: 'what-is-incentifi',
    title: 'What is incentifi?',
    body: [
      'incentifi is a launchpad, marketplace, and token page experience built for EVM creators. It helps anyone launch a token, publish a market page, and trade with holder protection in one place.',
      'The platform is designed around holder-aligned launches. That means every router trade builds the Loss Reward Pool for underwater holders while directly compensating the token creator.',
      'incentifi does not promise returns. It gives creators a clearer launch surface and gives traders on-chain protection and transparency.',
    ],
  },
  {
    id: 'why-incentifi-exists',
    title: 'Why incentifi Exists',
    body: [
      'Many token launches feel rushed, shallow, and confusing. Rules are often unclear, project links are scattered, and users trade before understanding how the launch is supposed to work.',
      'incentifi exists to make launches feel more deliberate. The market page gives users discovery tools, the token page gives them trading context, and the docs explain the rule in plain language.',
      'The goal is a stronger launch environment: clearer rules, better project identity, on-chain fee transparency, and loss-reward distributions for holders.',
    ],
  },
  {
    id: 'quick-start-guide',
    title: 'Quick Start Guide',
    body: ['Get started with incentifi in a few minutes.'],
    steps: [
      { title: 'Connect Your Wallet', body: 'Use the Connect Wallet button, choose your EVM wallet, and approve the connection request.' },
      { title: 'Explore Tokens', body: 'Browse the market, use search, filter by category, and open any token card to inspect the detail page.' },
      { title: 'Review the Route', body: 'Open the Guide modal or docs before trading so you understand how router fee splits and loss-reward distributions work.' },
      { title: 'Launch a Token', body: 'Go to Launch, enter token details (name, ticker, description, image, socials), and approve the deployment transaction in your wallet.' },
      { title: 'Trade with Protection', body: 'On token pages, trade through the Incentifi Router. Review chart, market stats, position area, and wallet prompts before confirming.' },
    ],
  },
  {
    id: 'how-it-works',
    title: 'How It Works',
    body: [
      'Each token moves through a simple product lifecycle: deployment, discovery, trading, and ongoing holder rewards.',
      'During launch, the creator enters token details and deploys an ERC-20 contract with fixed 1B supply. During discovery, the token appears in the market grid.',
      'During trading, all router trades distribute a 1.0% fee split between creator (0.5%) and Loss Reward Pool (0.5%), funding hourly reward distributions for eligible underwater holders.',
    ],
  },
  {
    id: 'connect-wallet',
    title: 'Connect Wallet',
    body: [
      'Wallet connection is required for token creation and trading actions. Visitors can browse the market and read docs without connecting.',
      'When connecting, verify that you are connected to Robinhood Chain. Every transaction requires explicit approval from your wallet.',
      'incentifi never asks for private keys or seed phrases. Only connect through the visible wallet button on the official site.',
    ],
  },
  {
    id: 'supported-wallets',
    title: 'Supported Wallets',
    body: [
      'incentifi is designed for common EVM wallets such as MetaMask, Rabby, Coinbase Wallet, Rainbow, Trust Wallet, and Robinhood Wallet.',
      'If your wallet is not detected, unlock the extension or mobile wallet, check browser permissions, and reload the page.',
      'Hardware wallet setups may work through a supported browser wallet, depending on the wallet provider and network settings.',
    ],
  },
  {
    id: 'network-rpc',
    title: 'Network & RPC',
    body: [
      'incentifi runs as an EVM launch experience on Robinhood Chain. RPC availability can affect wallet prompts, transaction status, and token data refreshes.',
      'If a transaction seems delayed, check your wallet first, then refresh the token page after confirmation.',
    ],
  },
  {
    id: 'ui-overview',
    title: 'UI Overview',
    body: [
      'The incentifi interface is organized around five major surfaces: fixed header navigation, the market area, token cards, token detail pages, and documentation.',
      'Desktop users get Guide, Market, Creators, Docs, Launch, and wallet connection in the header. On phones, the wallet stays in the header while the main actions move into a bottom navigation bar.',
    ],
  },
  {
    id: 'header-navigation',
    title: 'Header & Navigation',
    body: [
      'The header is fixed at the top so wallet access and brand context stay visible while users scroll. Mobile actions are separated into a bottom four-part bar for fast access.',
      'Guide opens the incentifi explainer modal. Market jumps to launched tokens. Creators jumps to the creator profile section. Docs opens this documentation page. Launch opens the token creation flow.',
    ],
  },
  {
    id: 'token-ticker-banner',
    title: 'Token Ticker Banner',
    body: [
      'The ticker banner summarizes the platform context with short phrases such as router protection, creator fees, and market status.',
      'Its purpose is to keep the incentifi model visible while users move toward the market grid.',
    ],
  },
  {
    id: 'home-page',
    title: 'Home Page',
    body: [
      'The home page introduces incentifi, shows live platform stats, provides the Create Coin and Read Docs actions, and opens into the launched token market.',
      'Below the market, the page includes additional explanation sections for creator identity, visible rules, wallet-first usage, EVM-native behavior, and rule clarity.',
    ],
  },
  {
    id: 'mobile-experience',
    title: 'Mobile Experience',
    body: [
      'incentifi is fully responsive for phone screens. The main mobile actions sit in a fixed bottom bar, buttons remain touch-friendly, and token cards stack cleanly.',
      'The site provides a fast, native-feeling mobile experience on any modern mobile browser with wallet support.',
    ],
  },
  {
    id: 'pwa-installation',
    title: 'PWA Installation',
    body: [
      'A future incentifi PWA can let users add the site to their home screen for a more app-like experience.',
      'When enabled, supported browsers will show install prompts or allow installation from the browser menu. iOS users can install through Share, then Add to Home Screen.',
    ],
  },
  {
    id: 'explore-tokens',
    title: 'Explore Tokens',
    body: [
      'The Explore area is the market grid. It shows all launched tokens and gives users a quick way to compare symbols, names, creator addresses, market caps, and launch age.',
      'Every card links to a token detail page where the user can review the token more deeply before taking action.',
    ],
  },
  {
    id: 'search-tokens',
    title: 'Search Tokens',
    body: [
      'The search bar supports token name, symbol, and contract address search. Search is intended to be quick and forgiving so users can narrow the grid without leaving the page.',
      'Discovery feels fast even when many tokens exist on the platform.',
    ],
  },
  {
    id: 'filter-sort',
    title: 'Filter & Sort',
    body: [
      'Category filters help users browse by broad intent such as Meme, DeFi, Gaming, AI, and Utility. Sorting helps users switch between newest launches, trending behavior, and top gainers.',
      'Filters keep exploration organized as more tokens launch.',
    ],
  },
  {
    id: 'token-cards',
    title: 'Token Cards',
    body: [
      'Token cards show image, name, symbol, creator, age, market cap, and a Trade badge. If no image is available, the card falls back to a clean symbol placeholder.',
      'Cards are compact so users can scan many launches quickly before choosing which token to open.',
    ],
  },
  {
    id: 'watchlist',
    title: 'Watchlist',
    body: [
      'The watchlist feature lets users star tokens, persist favorites locally, and keep key projects in view.',
      'This helps traders monitor their favorite tokens over time directly on the platform.',
    ],
  },
  {
    id: 'launch-page',
    title: 'Launch Page',
    body: [
      'The launch page collects token name, symbol, description, token image, website, X (Twitter), and Telegram.',
      'It creates a fixed-supply ERC-20 token (1 billion supply, 18 decimals) on Robinhood Chain, minted directly to the creator wallet.',
    ],
  },
  {
    id: 'launch-process',
    title: 'Launch Process',
    steps: [
      { title: 'Navigate', body: 'Click Launch in the header or hero area.' },
      { title: 'Connect Wallet', body: 'Connect a supported EVM wallet before submitting the launch transaction.' },
      { title: 'Fill Details', body: 'Enter name, symbol, description, image, and social links.' },
      { title: 'Review', body: 'Check spelling, links, and symbol before confirming.' },
      { title: 'Approve', body: 'Approve the token deployment transaction in your wallet and wait for confirmation.' },
    ],
    body: ['The launch flow is fast and straightforward, requiring only standard network gas for token contract deployment.'],
  },
  {
    id: 'token-details',
    title: 'Token Details',
    body: [
      'Token details include the visible identity of the token: name, ticker, description, image, and project links.',
      'Clear details help users understand whether they are viewing the right token and verify project links.',
    ],
  },
  {
    id: 'token-image',
    title: 'Token Image',
    body: [
      'Token images should be square, readable at small sizes, and visually distinct.',
      'If no image is provided, incentifi uses a symbol fallback so the card still looks complete.',
    ],
  },
  {
    id: 'creation-fees',
    title: 'Creation Fees',
    body: [
      'Token creation on Robinhood Chain requires only standard native ETH network gas to deploy the ERC-20 token contract.',
      'There are no hidden fees or mandatory liquidity deposits required from the creator.',
    ],
  },
  {
    id: 'token-page',
    title: 'Token Detail Page',
    body: [
      'Each token has a focused page with token identity, top stats, price/chart area, trade panel, position information, market data, and project links.',
      'The page makes the current token metrics and the Incentifi router trading flow obvious at a glance.',
    ],
  },
  {
    id: 'trading-flow',
    title: 'Trading Flow',
    body: [
      'The trading flow starts from discovery, moves into review, then wallet confirmation. Users review token details, market stats, slippage, and wallet prompts before confirming.',
      'Trades execute through the IncentifiSwapRouter contract on Robinhood Chain with automatic fee splitting and cost-basis tracking.',
    ],
  },
  {
    id: 'buying-tokens',
    title: 'Buying Tokens',
    body: [
      'Buying tokens uses native ETH through the Incentifi router. When you buy, the router updates your tracked cost basis.',
      'A 1.0% fee is deducted from the trade: 0.5% goes directly to the token creator in native ETH and 0.5% is deposited into the Loss Reward Pool.',
    ],
  },
  {
    id: 'selling-tokens',
    title: 'Selling Tokens',
    body: [
      'Selling tokens routes through the Incentifi router. If you sell at a profit, your remaining position retains loss-reward eligibility.',
      'If a position is sold below average entry price (underwater), the sale is executed and the wallet is disqualified from claiming loss rewards for that epoch, preventing manufactured loss exploits.',
    ],
  },
  {
    id: 'slippage-settings',
    title: 'Slippage Settings',
    body: [
      'Slippage controls the maximum price movement a user accepts during execution. Lower slippage gives tighter execution but may fail during high volatility.',
      'Higher slippage can help transactions execute quickly, but can lead to worse execution prices. Users should adjust based on market conditions.',
    ],
  },
  {
    id: 'position-tracking',
    title: 'Position Tracking',
    body: [
      'Position tracking displays token balance, average entry price (cost basis), total ETH invested, and current profit/loss status.',
      'Clear position data ensures traders always know whether their position is profitable or underwater.',
    ],
  },
  {
    id: 'price-charts',
    title: 'Price Charts',
    body: [
      'Interactive candlestick and line charts give users a visual history of market price movement.',
      'Charts update in real-time as trades execute across the platform.',
    ],
  },
  {
    id: 'share-social',
    title: 'Share & Social',
    body: [
      'Social links and share actions help creators share their token page across X, Telegram, and other channels.',
      'Sharing drives attention directly to the verified token page.',
    ],
  },
  {
    id: 'incentive-routing-overview',
    title: 'Incentive Routing',
    body: [
      'Incentive routing is the core Incentifi mechanism. Every trade routed through IncentifiSwapRouter applies a 1.0% trading fee.',
      '50% of the fee (0.5%) is forwarded directly to the token creator in native ETH, and 50% (0.5%) is deposited into the Loss Reward Pool for the token.',
      'The Loss Reward Pool distributes up to 10% of available rewards hourly to eligible underwater token holders via cryptographic Merkle proofs.',
    ],
  },
  {
    id: 'routing-calculation',
    title: 'Route Calculation',
    body: [
      'Cost basis equals total ETH spent divided by tokens acquired. If current 30-minute TWAP price is below cost basis, the held position is considered underwater.',
      'Eligible underwater holders receive a proportional share of the hourly Loss Reward Pool distribution in native ETH, bounded by their unrealized loss and available pool balance.',
    ],
  },
  {
    id: 'cost-basis',
    title: 'Cost Basis',
    body: [
      'Cost basis is the weighted average entry price for a wallet position, recorded from routed buys.',
      'Wallet transfers cap the recipient cost basis at the current TWAP price to prevent manufactured loss exploitation between colluding wallets.',
    ],
  },
  {
    id: 'rule-application',
    title: 'Rule Application',
    body: [
      'The platform routes users through the Incentifi router contract, ensuring all trades participate in creator fee sharing and holder protections.',
      'On-chain invariants enforce strict isolation between tokens and guarantee pool solvency at all times.',
    ],
  },
  {
    id: 'external-dex',
    title: 'External DEX Trading',
    body: [
      'If a token is traded directly on Uniswap V3 outside the Incentifi router, direct buyers receive 0 cost basis tracking.',
      'Direct underwater sells on external pools are detected by the indexer and trigger disqualification from loss-reward distributions.',
    ],
  },
  {
    id: 'treasury',
    title: 'Treasury & Loss Pool',
    body: [
      'Every trade through the router generates revenue: half to the creator wallet as creator revenue, and half into the LossRewardPool contract.',
      'Loss pool funds are held securely in the LossRewardPool smart contract and can only be claimed by eligible holders presenting valid Merkle proofs.',
    ],
  },
  {
    id: 'tokenomics',
    title: 'Tokenomics',
    body: [
      'Total Supply: 1,000,000,000 (1 Billion) tokens fixed at launch.',
      'Decimals: 18 (standard EVM ERC-20).',
      'Trading Fee: 1.0% on router swaps (0.50% to Creator, 0.50% to Loss Reward Pool).',
    ],
  },
  {
    id: 'profile',
    title: 'Profile',
    body: [
      'The Profile area shows wallet context, created tokens, trading history, and portfolio status.',
      'It provides a single dashboard for creators and traders to manage their tokens.',
    ],
  },
  {
    id: 'achievements',
    title: 'Achievements',
    body: [
      'Achievements highlight platform milestones such as first launch, active trading, and holder participation.',
      'Milestones encourage transparent, long-term participation across the ecosystem.',
    ],
  },
  {
    id: 'security',
    title: 'Security',
    body: [
      'Smart contracts implement reentrancy protection, checked math, TWAP oracle checks, and cryptographic Merkle proof verification for reward claims.',
      'All economic invariants and bypass resistance mechanisms have undergone comprehensive adversarial auditing.',
    ],
  },
  {
    id: 'risks',
    title: 'Risks & Disclaimers',
    body: [
      'Crypto trading carries risk. Tokens can fluctuate in value, and smart contracts operate on public blockchain infrastructure.',
      'Nothing in incentifi documentation constitutes financial advice. Users should always do their own research.',
    ],
  },
  {
    id: 'faq',
    title: 'Frequently Asked Questions',
    body: [
      'Why launch on incentifi? Because it provides built-in creator revenue and loss-reward protections for token holders.',
      'How does the fee split work? Every trade through the router applies a 1.0% fee: 0.5% to the creator in native ETH and 0.5% to the Loss Reward Pool.',
      'How are loss rewards claimed? Eligible underwater holders claim their share of the Loss Reward Pool using verified Merkle proofs generated by the indexer.',
    ],
  },
  {
    id: 'glossary',
    title: 'Glossary',
    body: [
      'ERC-20: Standard Ethereum/EVM token standard used for all Incentifi tokens.',
      'Incentifi Router: The smart contract gateway that executes trades and splits fees between creator and loss pool.',
      'Loss Reward Pool: The on-chain vault that collects fee revenue and distributes hourly loss rewards to underwater holders.',
      'Cost Basis: The weighted average purchase price of a token position.',
      'TWAP: Time-Weighted Average Price used to assess fair market value without flash-loan manipulation.',
      'Merkle Proof: A cryptographic proof that allows eligible holders to claim their exact reward on-chain.',
    ],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    body: [
      'If a transaction fails, check wallet balance for network gas, slippage tolerance, and ensure you approved the wallet prompt.',
      'If tokens do not appear immediately, wait for network confirmation and refresh the page.',
      'Ensure your wallet is connected to Robinhood Chain.',
    ],
  },
  {
    id: 'support',
    title: 'Support',
    body: [
      'For support, consult the official repository and community channels.',
      'When reporting an issue, include your wallet address, transaction hash, and a brief description of the problem.',
    ],
  },
];

const DocsPage = () => {
  const [contentsOpen, setContentsOpen] = useState(false);

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#071012] text-[#E8EEF9]">
      <header className="fixed left-0 right-0 top-0 z-50 border-b border-[#183033] bg-[#071012]/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:h-20 sm:px-6">
          <Link to="/" className="flex min-w-0 items-center gap-3">
            <img src={LOGO_URL} alt="incentifi" className="h-10 w-10 rounded-xl" />
            <div className="min-w-0">
              <div className="brand-type truncate text-base font-semibold sm:text-lg">Documentation</div>
              <div className="hidden text-xs text-[#769196] sm:block">incentifi v1.0</div>
            </div>
          </Link>
          <Link to="/" className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-[#183033] px-3 py-2 text-sm font-semibold text-[#8EA2A7] hover:text-white sm:px-4">
            <Home className="h-4 w-4 shrink-0" />
            <span className="hidden sm:inline">Home</span>
          </Link>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl grid-cols-1 pt-[8.75rem] sm:pt-[9.75rem] lg:block lg:pt-20">
        <aside className="scrollbar-stealth fixed left-0 right-0 top-16 z-40 border-b border-[#183033] bg-[#071012]/98 backdrop-blur sm:top-20 lg:left-[max(0px,calc((100vw-80rem)/2))] lg:right-auto lg:top-20 lg:h-[calc(100vh-5rem)] lg:w-80 lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <div className="mx-auto max-w-7xl p-4 sm:p-6 lg:mx-0">
            <button
              type="button"
              onClick={() => setContentsOpen((open) => !open)}
              className="flex w-full items-center justify-between rounded-2xl border border-[#183033] bg-[#0B171A] px-4 py-3 text-left lg:mb-4 lg:pointer-events-none"
              aria-expanded={contentsOpen}
            >
              <span className="inline-flex items-center gap-2 text-sm font-extrabold uppercase text-[#8EA2A7]">
                <Menu className="h-4 w-4" />
                Contents
              </span>
              <ChevronDown className={`h-4 w-4 text-[#587075] transition lg:hidden ${contentsOpen ? 'rotate-180' : ''}`} />
              <ChevronUp className="hidden h-4 w-4 text-[#587075] lg:block" />
            </button>

            <nav className={`${contentsOpen ? 'block' : 'hidden'} scrollbar-stealth mt-4 max-h-[58vh] space-y-7 overflow-y-auto rounded-2xl border border-[#183033] bg-[#071012] p-3 shadow-2xl shadow-black/50 lg:mt-0 lg:block lg:max-h-none lg:overflow-visible lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none`}>
              {navGroups.map((group) => (
                <div key={group.label}>
                  <div className="mb-3 px-4 text-xs font-extrabold uppercase tracking-widest text-[#587075]">
                    {group.label}
                  </div>
                  <div className="space-y-2">
                    {group.items.map((item) => (
                      <a
                        key={item.id}
                        href={`#${item.id}`}
                        onClick={() => setContentsOpen(false)}
                        className={`flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-semibold transition ${
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
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#14B8A6]/25 bg-[#14B8A6]/10 px-4 py-2 text-sm font-semibold text-[#72E0D5]">
              <FileText className="h-4 w-4" />
              Developer and user guide
            </div>
            <h1 className="text-4xl font-semibold text-white sm:text-5xl">incentifi Documentation</h1>
            <p className="mt-5 max-w-3xl text-lg leading-8 text-[#8EA2A7]">
              Learn how incentifi launches work, how wallets connect, how the market is organized, and how each interface supports holder-aligned tokens.
            </p>
          </div>

          <div className="space-y-14">
            {sections.map((section) => (
              <section key={section.id} id={section.id} className="scroll-mt-24">
                <h2 className="text-2xl font-semibold text-white sm:text-3xl">{section.title}</h2>
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
                        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#14B8A6] text-xl font-semibold text-[#031011]">
                          {index + 1}
                        </div>
                        <div>
                          <h3 className="text-xl font-semibold text-white">{step.title}</h3>
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

