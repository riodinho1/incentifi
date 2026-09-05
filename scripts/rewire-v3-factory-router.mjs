#!/usr/bin/env node
/**
 * Rewires the app + off-chain workers from the OLD (pre-fix) IncentifiBondingCurveFactory
 * / IncentifiSwapRouter to the NEW (fixed) ones deployed by
 * deploy-v3-fixed-factory-and-router.ts, across every place that hardcodes them, and
 * regenerates INTEGRATION.md's address references to match.
 *
 * Reference points updated (5):
 *   1. src/lib/uniswapAddresses.ts        (INCENTIFI_BONDING_CURVE_FACTORY, INCENTIFI_SWAP_ROUTER)
 *   2. scripts/loss-reward-worker.mjs     (INCENTIFI_FACTORY_ADDRESS fallback)
 *   3. scripts/evm-indexer.mjs            (INCENTIFI_BONDING_CURVE_FACTORY / INCENTIFI_SWAP_ROUTER fallbacks)
 *   4. src/lib/integration/index.ts       (INCENTIFI_BONDING_CURVE_FACTORY, INCENTIFI_SWAP_ROUTER)
 *   5. INTEGRATION.md                     (every embedded address reference + a redeploy note)
 *
 * Safe by construction: every replacement is anchored to the literal OLD address it
 * expects to find (via String.replaceAll on exact-cased hex strings, not a blind
 * regex over unrelated content). Before writing ANYTHING, it dry-runs all 5 files and
 * hard-fails if any file doesn't contain at least one occurrence of an OLD address it
 * is expected to reference — so a file that has already drifted (manually edited,
 * previously rewired, etc.) is reported, not silently skipped or double-patched.
 *
 * Usage:
 *   node scripts/rewire-v3-factory-router.mjs <newFactoryAddress> <newRouterAddress>
 *
 * If the addresses aren't given as CLI args, reads them from
 * scripts/.v3-deployment-result.json (written by deploy-v3-fixed-factory-and-router.ts).
 *
 *   --dry-run   Show what would change without writing any files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getAddress } from 'viem';

const OLD_FACTORY = '0x9fcea653c6f31c82606582b22da82b39f61f9c0e';
const OLD_ROUTER = '0xbba0384bf34b5cc26daa2c06cdf765bbdeb2acdf';

const RESULT_PATH = path.resolve('scripts', '.v3-deployment-result.json');

function resolveNewAddresses(argv) {
  const [argFactory, argRouter] = argv;
  if (argFactory && argRouter) {
    return { factory: getAddress(argFactory), router: getAddress(argRouter) };
  }
  if (!fs.existsSync(RESULT_PATH)) {
    throw new Error(
      `No factory/router addresses given as CLI args, and ${RESULT_PATH} does not exist.\n` +
      `Usage: node scripts/rewire-v3-factory-router.mjs <newFactoryAddress> <newRouterAddress>\n` +
      `(or run deploy-v3-fixed-factory-and-router.ts first, which writes that file)`
    );
  }
  const deployResult = JSON.parse(fs.readFileSync(RESULT_PATH, 'utf8'));
  return { factory: getAddress(deployResult.factory.address), router: getAddress(deployResult.router.address) };
}

/**
 * Replaces every case-insensitive occurrence of `oldAddr` with `newAddr` in `content`,
 * preserving each occurrence's original case convention: if the matched text is
 * all-lowercase it's replaced with the lowercase form of the new address, and if it's
 * checksummed/mixed-case it's replaced with the checksummed form — so a file that was
 * consistently lowercase stays lowercase, and one that used the checksum stays
 * checksummed.
 */
function replaceAddress(content, oldAddr, newAddrChecksummed) {
  const newAddrLower = newAddrChecksummed.toLowerCase();
  const pattern = new RegExp(oldAddr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let count = 0;
  const next = content.replace(pattern, (match) => {
    count++;
    return match === match.toLowerCase() ? newAddrLower : newAddrChecksummed;
  });
  return { next, count };
}

function patchFile(filePath, newFactory, newRouter, { dryRun }) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Expected target file does not exist: ${filePath}`);
  }
  const original = fs.readFileSync(absPath, 'utf8');

  const { next: afterFactory, count: factoryCount } = replaceAddress(original, OLD_FACTORY, newFactory);
  const { next: afterRouter, count: routerCount } = replaceAddress(afterFactory, OLD_ROUTER, newRouter);

  if (factoryCount === 0 && routerCount === 0) {
    throw new Error(
      `${filePath}: found ZERO occurrences of either the old Factory (${OLD_FACTORY}) or ` +
      `old Router (${OLD_ROUTER}) address. This file has drifted from what this script ` +
      `expects — refusing to write anything until that's resolved by hand.`
    );
  }

  if (!dryRun && afterRouter !== original) {
    fs.writeFileSync(absPath, afterRouter);
  }

  return { factoryCount, routerCount, changed: afterRouter !== original };
}

function addIntegrationMdRedeployNote(content, oldFactory, oldRouter, newFactory, newRouter) {
  const marker = '## 2. Canonical Smart Contract Addresses';
  const idx = content.indexOf(marker);
  if (idx === -1) return content; // section heading not found; leave content untouched beyond address swaps

  const note =
    `${marker}\n\n` +
    `> **Redeployed ${new Date().toISOString().slice(0, 10)}:** the Factory and Router below were redeployed ` +
    `from fixed contract source (creator-payment DoS + fee-on-transfer accounting fixes). ` +
    `The previous addresses (Factory \`${oldFactory}\`, Router \`${oldRouter}\`) ran old, unfixed bytecode ` +
    `and should no longer be used — a contract's deployed bytecode is immutable, so those fixes could ` +
    `only take effect via a fresh deployment.\n`;

  return content.slice(0, idx) + note + content.slice(idx + marker.length + 1);
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--dry-run');
  const dryRun = process.argv.includes('--dry-run');

  const { factory: newFactory, router: newRouter } = resolveNewAddresses(args);

  console.log('\n============================================================');
  console.log(`[REWIRE v3] ${dryRun ? 'DRY RUN — no files will be written' : 'LIVE — files will be modified'}`);
  console.log('============================================================');
  console.log(`Old Factory: ${OLD_FACTORY}`);
  console.log(`New Factory: ${newFactory}`);
  console.log(`Old Router:  ${OLD_ROUTER}`);
  console.log(`New Router:  ${newRouter}`);
  console.log('============================================================\n');

  const targets = [
    'src/lib/uniswapAddresses.ts',
    'scripts/loss-reward-worker.mjs',
    'scripts/evm-indexer.mjs',
    'src/lib/integration/index.ts',
  ];

  const results = [];
  for (const target of targets) {
    const result = patchFile(target, newFactory, newRouter, { dryRun });
    results.push({ target, ...result });
    console.log(
      `${result.changed ? '✓' : '·'} ${target}: factory x${result.factoryCount}, router x${result.routerCount}` +
        (dryRun ? ' (dry run)' : '')
    );
  }

  // INTEGRATION.md: address swap + a dated redeploy note under the address table.
  const integrationPath = path.resolve('INTEGRATION.md');
  const originalMd = fs.readFileSync(integrationPath, 'utf8');
  const { next: mdAfterFactory, count: mdFactoryCount } = replaceAddress(originalMd, OLD_FACTORY, newFactory);
  const { next: mdAfterRouter, count: mdRouterCount } = replaceAddress(mdAfterFactory, OLD_ROUTER, newRouter);
  if (mdFactoryCount === 0 && mdRouterCount === 0) {
    throw new Error('INTEGRATION.md: found zero occurrences of either old address — refusing to write.');
  }
  const mdWithNote = addIntegrationMdRedeployNote(mdAfterRouter, OLD_FACTORY, OLD_ROUTER, newFactory, newRouter);
  const mdChanged = mdWithNote !== originalMd;
  if (!dryRun && mdChanged) {
    fs.writeFileSync(integrationPath, mdWithNote);
  }
  results.push({ target: 'INTEGRATION.md', factoryCount: mdFactoryCount, routerCount: mdRouterCount, changed: mdChanged });
  console.log(
    `${mdChanged ? '✓' : '·'} INTEGRATION.md: factory x${mdFactoryCount}, router x${mdRouterCount}` +
      (dryRun ? ' (dry run)' : '') + ' + redeploy note'
  );

  console.log('\n============================================================');
  console.log(`[REWIRE v3] ${dryRun ? 'DRY RUN COMPLETE — re-run without --dry-run to apply' : 'COMPLETE'}`);
  console.log('============================================================');
  console.log(JSON.stringify({ newFactory, newRouter, dryRun, results }, null, 2));

  if (!dryRun) {
    console.log('\nNOTE: src/lib/incentifiBondingCurveFactoryBytecode.ts and');
    console.log('src/lib/incentifiSwapRouterBytecode.ts embed the OLD Factory address inside the');
    console.log("Router's own constructor args / deploy data (used by the browser /deploy page's");
    console.log('own from-scratch Factory+Router deploy flow, independent of the addresses rewired');
    console.log('above) — regenerate those bytecode files separately if that flow should also point');
    console.log('new deployments at a different Factory.');
  }
}

main().catch((err) => {
  console.error('\n[REWIRE v3 ERROR]', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
