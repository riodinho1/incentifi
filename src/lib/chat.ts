import { supabase } from './supabase';

export type ChatMessage = {
  id: number;
  symbol: string;
  walletAddress: string;
  message: string;
  createdAt: string;
};

export const fetchChatMessages = async (symbol: string, limit = 100): Promise<ChatMessage[]> => {
  const { data, error } = await supabase
    .from('token_chat_messages')
    .select('*')
    .eq('symbol', symbol.toUpperCase())
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(error.message);

  return (data || []).map((row: any) => ({
    id: row.id,
    symbol: row.symbol,
    walletAddress: row.wallet_address,
    message: row.message,
    createdAt: row.created_at,
  }));
};

export const postChatMessage = async (symbol: string, walletAddress: string, message: string) => {
  const trimmed = message.trim().slice(0, 500);
  if (!trimmed) throw new Error('Message cannot be empty.');

  const { error } = await supabase.from('token_chat_messages').insert({
    symbol: symbol.toUpperCase(),
    wallet_address: walletAddress,
    message: trimmed,
  });

  if (error) throw new Error(error.message);
};
