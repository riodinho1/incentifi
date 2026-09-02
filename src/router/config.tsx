import type { RouteObject } from 'react-router-dom';
import HomePage from '../pages/home/page';
import LaunchPage from '../pages/launch/page';
import TokenPreviewPage from '../pages/token-preview/page';
import Whitepaper from '../pages/whitepaper/page';
import Audit from '../pages/audit/page';
import DocsPage from '../pages/docs/page';
import DeployContractsPage from '../pages/deploy/page';
import NotFound from '../pages/NotFound';

const routes: RouteObject[] = [
  {
    path: '/',
    element: <HomePage />,
  },
  {
    path: '/launch',
    element: <LaunchPage />,
  },
  {
    path: '/token-preview/:symbol',
    element: <TokenPreviewPage />,
  },
  {
    path: '/whitepaper',
    element: <Whitepaper />,
  },
  {
    path: '/audit',
    element: <Audit />,
  },
  {
    path: '/docs',
    element: <DocsPage />,
  },
  {
    path: '/deploy',
    element: <DeployContractsPage />,
  },
  {
    path: '*',
    element: <NotFound />,
  },
];

export default routes;
