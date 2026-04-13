const requiredFrontend = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_SOLANA_NETWORK',
];

const requiredBackend = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TOKEN_SYMBOL',
];

const containsPlaceholder = (value) =>
  String(value || '').includes('YOUR_') || String(value || '').includes('your_');

const check = (keys, label) => {
  const missing = [];
  const placeholder = [];
  for (const key of keys) {
    const value = process.env[key];
    if (!value) missing.push(key);
    else if (containsPlaceholder(value)) placeholder.push(key);
  }
  return { label, missing, placeholder };
};

const frontend = check(requiredFrontend, 'frontend');
const backend = check(requiredBackend, 'backend');

const problems = [...frontend.missing, ...frontend.placeholder, ...backend.missing, ...backend.placeholder];
const mode = String(process.env.VITE_SOLANA_NETWORK || '').toLowerCase();
const networkWarning =
  mode && mode !== 'mainnet' && mode !== 'devnet'
    ? `Invalid VITE_SOLANA_NETWORK=${mode}. Use devnet or mainnet.`
    : '';

console.log('Phase 4 preflight');
console.log(JSON.stringify({ frontend, backend, networkWarning }, null, 2));

if (networkWarning) {
  process.exitCode = 1;
}
if (problems.length > 0) {
  console.error('Preflight failed: missing/placeholder env vars detected.');
  process.exit(1);
}

console.log('Preflight passed.');
