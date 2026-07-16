// Wallet/RPC errors (MetaMask, EIP-1193 providers) are often plain objects with a
// message field, not real Error instances, so a plain `instanceof Error` check misses
// the actual reason and silently discards it.
export const describeError = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const withMessage = err as { message?: unknown; error?: { message?: unknown } };
    if (typeof withMessage.message === 'string') return withMessage.message;
    if (typeof withMessage.error?.message === 'string') return withMessage.error.message;
  }
  return typeof err === 'string' ? err : 'Failed for an unknown reason.';
};
