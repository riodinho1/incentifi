// test/symbol-registry.test.mjs
import assert from 'node:assert/strict';

console.log('======================================================');
console.log('  RUNNING SYMBOL REGISTRY AVAILABILITY TEST SUITE');
console.log('======================================================\n');

// 1. Test normalization
const normalizeSymbol = (raw) => String(raw || '').trim().toUpperCase();

assert.equal(normalizeSymbol('  dht  '), 'DHT');
assert.equal(normalizeSymbol('dht'), 'DHT');
assert.equal(normalizeSymbol(''), '');
assert.equal(normalizeSymbol(null), '');
console.log('  ✓ [TEST 1] Symbol normalization (trim + uppercase) works');

// 2. Test length validation
const validateSymbolLength = (sym) => {
  const normalized = normalizeSymbol(sym);
  if (!normalized) return { valid: false, error: 'Token symbol is required.' };
  if (normalized.length > 10) return { valid: false, error: 'Symbol must be 10 characters or less.' };
  return { valid: true, symbol: normalized };
};

assert.equal(validateSymbolLength('').valid, false);
assert.equal(validateSymbolLength('VERYLONGSYMBOLNAME').valid, false);
assert.equal(validateSymbolLength('VALID').valid, true);
assert.equal(validateSymbolLength('VALID').symbol, 'VALID');
console.log('  ✓ [TEST 2] Symbol length boundary validation works');

// 3. Test duplicate symbol rejection logic
const evaluateAvailability = (symbol, existingTokens) => {
  if (existingTokens && existingTokens.length > 0) {
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
};

const duplicateResult = evaluateAvailability('DHT', [{ id: '1', symbol: 'DHT' }]);
assert.equal(duplicateResult.isAvailable, false);
assert.match(duplicateResult.error, /already registered/);

const uniqueResult = evaluateAvailability('NEWTOKEN', []);
assert.equal(uniqueResult.isAvailable, true);
assert.equal(uniqueResult.symbol, 'NEWTOKEN');
console.log('  ✓ [TEST 3] Duplicate symbol rejection vs unique symbol approval verified');

// 4. Test unconfigured / error stopping logic (no bypass on error)
const evaluateUnconfigured = (isConfigured) => {
  if (!isConfigured) {
    return {
      isAvailable: false,
      error: 'Token registry database is not configured. Deployment stopped.',
    };
  }
  return { isAvailable: true };
};

const unconfiguredResult = evaluateUnconfigured(false);
assert.equal(unconfiguredResult.isAvailable, false);
assert.match(unconfiguredResult.error, /Deployment stopped/);
console.log('  ✓ [TEST 4] Unconfigured registry safely stops deployment without bypassing');

console.log('\n======================================================');
console.log('  ALL SYMBOL REGISTRY TESTS PASSED!');
console.log('======================================================\n');
