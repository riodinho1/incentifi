import * as web3 from '@solana/web3.js';

export const waitForConfirmedSignature = async (
  connection: web3.Connection,
  signature: string,
  timeoutMs = 45_000
) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const statuses = await connection.getSignatureStatuses([signature]);
    const status = statuses.value[0];
    if (status?.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error('Transaction confirmation timed out. Check wallet history for final status.');
};
