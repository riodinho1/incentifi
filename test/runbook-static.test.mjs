/**
 * RUNBOOK STATIC CHECKS — scripts/ops/Deploy-LossRewardV2.ps1.
 *
 * Bug this pins: "...on $V2?" — PowerShell reads `$V2?` as a variable NAMED "V2?" (and `$Var:` as a
 * drive-qualified variable), which under Set-StrictMode throws; with $ErrorActionPreference =
 * 'Continue' the failing Confirm-Typed statement was skipped and the broadcast ran WITHOUT its gate.
 *
 *   1. no double-quoted string interpolates a bare `$Var` followed by ? : ! or [ (must be `${Var}`),
 *      `$env:` / `$script:` scopes and `$( ... )` subexpressions excepted
 *   2. every broadcasting step (a Get-WalletArgs call) is preceded by Assert-Gate '<WORD>' matching the
 *      Confirm-Typed '<WORD>' right before it - the fail-closed guard against a skipped prompt
 *   3. Confirm-Typed records the accepted word and Assert-Gate consumes it
 *
 * Run: node test/runbook-static.test.mjs   (part of `npm test`)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync('scripts/ops/Deploy-LossRewardV2.ps1', 'utf8').replace(/\r\n/g, '\n');
const lines = src.split('\n');

console.log('======================================================');
console.log('  RUNBOOK STATIC CHECKS (Deploy-LossRewardV2.ps1)');
console.log('======================================================\n');

// 1. bare $Var followed by ? : ! [ inside double-quoted strings
const offenders = [];
lines.forEach((line, i) => {
  if (line.trim().startsWith('#')) return;
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const str = m[1].replace(/\$\((?:[^()]|\([^()]*\))*\)/g, ''); // drop $( ... ) subexpressions
    for (const v of str.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)([?:!\[])/g)) {
      if (v[1] === 'env' || v[1] === 'script') continue;
      offenders.push(`${i + 1}: $${v[1]}${v[2]}  in  "${m[1]}"`);
    }
  }
});
assert.deepEqual(offenders, [], 'bare $Var? / $Var: / $Var! / $Var[ interpolation(s) found');
console.log('1. no bare $Var?/:/!/[ interpolations in double-quoted strings  OK');

// 2. every Get-WalletArgs is guarded by Assert-Gate of the word Confirm-Typed asked for, in that order
const walletCalls = lines.map((l, i) => [l, i]).filter(([l]) => /Get-WalletArgs\b/.test(l) && !/^\s*function\b/.test(l) && !/Get-DryRunSenderArgs|return \(Get-WalletArgs\)/.test(l));
assert.ok(walletCalls.length >= 3, `expected the 3 broadcast steps to call Get-WalletArgs (found ${walletCalls.length})`);
let guarded = 0;
for (const [, idx] of walletCalls) {
  // look back within the step (up to the previous "'<Step>' {" line) for Confirm-Typed / Assert-Gate pairs
  let stepStart = idx;
  while (stepStart > 0 && !/^\s*'[A-Za-z]+' \{\s*$/.test(lines[stepStart])) stepStart--;
  const block = lines.slice(stepStart, idx);
  const confirms = block.map((l) => l.match(/Confirm-Typed '([A-Z0-9-]+)'/)).filter(Boolean).map((m) => m[1]);
  const asserts = block.map((l) => l.match(/Assert-Gate '([A-Z0-9-]+)'/)).filter(Boolean).map((m) => m[1]);
  assert.ok(confirms.length >= 1, `step at line ${stepStart + 1}: Get-WalletArgs without a Confirm-Typed gate`);
  assert.deepEqual(asserts, confirms, `step at line ${stepStart + 1}: every Confirm-Typed must be followed by Assert-Gate of the same word, in order`);
  const lastAssert = block.map((l, i) => (/Assert-Gate '/.test(l) ? i : -1)).filter((i) => i >= 0).pop();
  const lastConfirm = block.map((l, i) => (/Confirm-Typed '/.test(l) ? i : -1)).filter((i) => i >= 0).pop();
  assert.ok(lastAssert > lastConfirm, `step at line ${stepStart + 1}: Assert-Gate must come after its Confirm-Typed`);
  guarded++;
}
console.log(`2. ${guarded} broadcast step(s) fetch the wallet only behind Confirm-Typed + Assert-Gate  OK`);

// 3. the gate functions themselves
assert.match(src, /function Confirm-Typed\(\$word, \$prompt\) \{[\s\S]*?\$script:gatePassed = ''[\s\S]*?Read-Host[\s\S]*?throw[\s\S]*?\$script:gatePassed = \$word/);
assert.match(src, /function Assert-Gate\(\$word\) \{[\s\S]*?if \(\$script:gatePassed -ne \$word\) \{ throw/);
console.log('3. Confirm-Typed records the word, Assert-Gate throws unless it matches  OK');

console.log('\nrunbook-static tests passed');
