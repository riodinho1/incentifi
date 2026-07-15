import { getEvmProvider } from './evmNetwork';

type Listener = () => void;

let account: string | null = null;
let initialized = false;
const listeners = new Set<Listener>();

const notify = () => listeners.forEach((listener) => listener());

const setAccount = (next: string | null) => {
  if (account === next) return;
  account = next;
  notify();
};

const init = () => {
  if (initialized) return;
  initialized = true;

  const provider = getEvmProvider();
  if (!provider) return;

  provider
    .request({ method: 'eth_accounts' })
    .then((accounts: string[]) => setAccount(accounts?.[0] || null))
    .catch(() => setAccount(null));

  provider.on?.('accountsChanged', (accounts: string[]) => setAccount(accounts?.[0] || null));
  provider.on?.('disconnect', () => setAccount(null));
};

export const getWalletAccount = () => {
  init();
  return account;
};

export const setWalletAccount = (next: string | null) => {
  init();
  setAccount(next);
};

export const subscribeWalletAccount = (listener: Listener) => {
  init();
  listeners.add(listener);
  return () => listeners.delete(listener);
};
