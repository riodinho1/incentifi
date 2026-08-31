import { supabase, isSupabaseConfigured } from './supabase';

export type SymbolCheckResult = {
  isAvailable: boolean;
  symbol: string;
  error?: string;
};

/**
 * Normalizes a token symbol to standard ticker format (trimmed and uppercase).
 */
export const normalizeSymbol = (rawSymbol: string): string => {
  return String(rawSymbol || '')
    .trim()
    .toUpperCase();
};

/**
 * Verifies whether a token symbol is available in the registry.
 * Checks both direct Supabase client and serverless API route.
 * Strictly enforces duplicate-symbol protection without bypassing checks on failure.
 */
export const verifySymbolAvailability = async (
  rawSymbol: string
): Promise<SymbolCheckResult> => {
  const symbol = normalizeSymbol(rawSymbol);

  if (!symbol) {
    return {
      isAvailable: false,
      symbol,
      error: 'Token symbol is required.',
    };
  }

  if (symbol.length > 10) {
    return {
      isAvailable: false,
      symbol,
      error: 'Symbol must be 10 characters or less.',
    };
  }

  // 1. If Supabase is configured directly in the client, query it first
  if (isSupabaseConfigured()) {
    try {
      const { data, error } = await supabase
        .from('tokens')
        .select('id, symbol')
        .eq('symbol', symbol)
        .limit(1);

      if (!error && Array.isArray(data)) {
        if (data.length > 0) {
          return {
            isAvailable: false,
            symbol,
            error: `$${symbol} is already registered. Please choose a different ticker before launching.`,
          };
        }
        return {
          isAvailable: true,
          symbol,
        };
      }

      console.warn('Direct Supabase symbol query returned error:', error);
    } catch (clientErr) {
      console.warn('Direct Supabase symbol query exception:', clientErr);
    }
  }

  // 2. Fallback to /api/check-symbol serverless endpoint
  try {
    const apiRes = await fetch(`/api/check-symbol?symbol=${encodeURIComponent(symbol)}`, {
      headers: { Accept: 'application/json' },
    });

    if (apiRes.ok) {
      const apiData = await apiRes.json();
      if (apiData.exists || apiData.available === false) {
        return {
          isAvailable: false,
          symbol,
          error: `$${symbol} is already registered. Please choose a different ticker before launching.`,
        };
      }
      if (apiData.available === true) {
        return {
          isAvailable: true,
          symbol,
        };
      }
    }
  } catch (apiErr) {
    console.warn('Serverless /api/check-symbol query failed:', apiErr);
  }

  // 3. If neither method could connect or verify the registry, stop deployment safely
  return {
    isAvailable: false,
    symbol,
    error:
      'Could not verify symbol availability with the token registry. Symbol verification is required to prevent ticker collisions. Please verify VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your environment.',
  };
};
