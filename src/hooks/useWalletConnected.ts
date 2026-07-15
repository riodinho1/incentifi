import { useSyncExternalStore } from 'react';
import { getWalletAccount, subscribeWalletAccount } from '../lib/walletAccount';

export const useWalletConnected = () => {
  const account = useSyncExternalStore(subscribeWalletAccount, getWalletAccount);
  return Boolean(account);
};
