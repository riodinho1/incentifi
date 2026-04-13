import { Routes, Route } from 'react-router-dom';
import HomePage from './pages/home/page';
import LaunchPage from './pages/launch/page';
import TokenPreviewPage from './pages/token-preview/page';
import Whitepaper from './pages/whitepaper/page';
import Audit from './pages/audit/page';
import NotFound from './pages/NotFound';

function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/launch" element={<LaunchPage />} />
      <Route path="/token-preview/:symbol" element={<TokenPreviewPage />} />
      <Route path="/whitepaper" element={<Whitepaper />} />
      <Route path="/audit" element={<Audit />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default App;