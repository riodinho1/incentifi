import { createClient, SupabaseClient } from '@supabase/supabase-js';

const rawUrl = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const rawKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

export const isSupabaseConfigured = (): boolean => {
  if (!rawUrl || !rawKey) return false;
  if (!rawUrl.startsWith('https://') && !rawUrl.startsWith('http://')) return false;
  if (rawUrl.includes('placeholder') || rawKey.includes('placeholder')) return false;
  return true;
};

// Safe fallback client instantiation to prevent uncaught runtime errors on import
const validUrl = isSupabaseConfigured() ? rawUrl : 'https://placeholder.supabase.co';
const validKey = isSupabaseConfigured() ? rawKey : 'placeholder-key';

export const supabase: SupabaseClient = createClient(validUrl, validKey);