// src/lib/createToken.ts
import * as web3 from '@solana/web3.js';
import * as splToken from '@solana/spl-token';
import { EXPLORER_ADDRESS_URL, EXPLORER_TX_URL, SOLANA_RPC_URL } from './network';

export const createRealToken = async (
  provider: any
) => {
  const connection = new web3.Connection(SOLANA_RPC_URL, 'confirmed');

  const fromWallet = provider.publicKey;
  const mint = web3.Keypair.generate();

  const mintRent = await splToken.getMinimumBalanceForRentExemptMint(connection);

  const createAccountIx = web3.SystemProgram.createAccount({
    fromPubkey: fromWallet,
    newAccountPubkey: mint.publicKey,
    space: splToken.MINT_SIZE,
    lamports: mintRent,
    programId: splToken.TOKEN_PROGRAM_ID,
  });

  const initMintIx = splToken.createInitializeMintInstruction(
    mint.publicKey,
    6,
    fromWallet,
    fromWallet
  );

  const transaction = new web3.Transaction().add(createAccountIx, initMintIx);

  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = fromWallet;

  transaction.partialSign(mint);

  const signed = await provider.signTransaction(transaction);
  const txid = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(txid);

  return {
    mint: mint.publicKey.toString(),
    explorer: EXPLORER_ADDRESS_URL(mint.publicKey.toString()),
    txExplorer: EXPLORER_TX_URL(txid),
  };
};
