/**
 * Reliable ERC-20 balance reads for money decisions (2026-09-09).
 *
 * The loss-reward worker pays on min(DB balance, chain balance) and the indexer's reconciliation
 * lowers DB balances to what the chain says. Both are only as good as the RPC answer, and the most
 * dangerous answer an endpoint can give is a well-formed ZERO (or any value below the DB) for a
 * wallet that does hold tokens: viem throws on empty/short data, but a node serving stale or foreign
 * state answers `0x000…0` and nothing downstream can tell. So:
 *
 *   - every read is pinned to one block (`blockNumber`), never "latest", so a run that rotates between
 *     endpoints reads one consistent state;
 *   - a result that is >= what the DB believes needs no confirmation (the cap can only lower a payout);
 *   - a result BELOW the DB is confirmed by a second, independent read: on a different endpoint of the
 *     failover provider when one is configured, otherwise the same endpoint again after a delay;
 *   - both agree -> accepted; they disagree -> `disputed` and the caller must skip the holder (never pay
 *     on either number, never write either number);
 *   - any read that throws propagates so the caller fails closed.
 */
import { encodeFunctionData, decodeFunctionResult, getAddress, parseAbi } from 'viem';

export const ERC20_BALANCE_OF_ABI = parseAbi(['function balanceOf(address account) view returns (uint256)']);

export const toHexBlock = (bn) => (bn === undefined || bn === null || bn === 'latest' ? 'latest' : '0x' + BigInt(bn).toString(16));

function decodeBalance(hex, wallet) {
  if (typeof hex !== 'string' || !hex.startsWith('0x') || hex.length < 66) {
    throw new Error(`balanceOf(${wallet}) returned ${JSON.stringify(hex)} instead of a 32-byte word`);
  }
  return BigInt(decodeFunctionResult({ abi: ERC20_BALANCE_OF_ABI, functionName: 'balanceOf', data: hex }));
}

/**
 * @param {object} p
 * @param {import('viem').PublicClient} p.client   viem client (its transport decides the primary endpoint)
 * @param {object|null} [p.rpc]                     the failover provider from createFailoverRpc (for a second endpoint)
 * @param {string} p.token
 * @param {string} p.wallet
 * @param {bigint|number|string} [p.blockNumber]   pinned block; default 'latest' (avoid in production paths)
 * @param {bigint} [p.expectedAtLeastWei=0n]        the DB's view; a lower read triggers confirmation
 * @param {number} [p.delayMs=750]                  wait before the same-endpoint re-read
 * @returns {Promise<{ balanceWei: bigint|null, primaryWei: bigint, confirmWei: bigint|null, confirmed: boolean, disputed: boolean, endpoints: (string|null)[] }>}
 */
export async function readBalanceReliably({ client, rpc = null, token, wallet, blockNumber = 'latest', expectedAtLeastWei = 0n, delayMs = 750, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const tokenAddr = getAddress(token);
  const walletAddr = getAddress(wallet);
  const params = [{ to: tokenAddr, data: encodeFunctionData({ abi: ERC20_BALANCE_OF_ABI, functionName: 'balanceOf', args: [walletAddr] }) }, toHexBlock(blockNumber)];

  const primaryWei = decodeBalance(await client.request({ method: 'eth_call', params }), walletAddr);
  const primaryUrl = rpc ? rpc.state.activeUrl : null;
  if (primaryWei >= BigInt(expectedAtLeastWei)) {
    return { balanceWei: primaryWei, primaryWei, confirmWei: null, confirmed: false, disputed: false, endpoints: [primaryUrl] };
  }

  // Below the DB: confirm independently.
  let confirmWei = null;
  let confirmUrl = primaryUrl;
  if (rpc && rpc.state.endpoints.length > 1) {
    const n = rpc.state.endpoints.length;
    const start = Math.max(0, rpc.state.endpoints.indexOf(primaryUrl));
    let lastErr = null;
    for (let k = 1; k < n; k++) {
      const i = (start + k) % n;
      try {
        confirmWei = decodeBalance(await rpc.requestVia(i, { method: 'eth_call', params }), walletAddr);
        confirmUrl = rpc.state.endpoints[i];
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (confirmWei === null) throw new Error(`balanceOf(${walletAddr}) read ${primaryWei} on ${primaryUrl} but no other endpoint could confirm it: ${lastErr?.shortMessage || lastErr?.message}`);
  } else {
    await sleep(delayMs);
    confirmWei = decodeBalance(await client.request({ method: 'eth_call', params }), walletAddr);
  }
  const disputed = confirmWei !== primaryWei;
  return { balanceWei: disputed ? null : primaryWei, primaryWei, confirmWei, confirmed: !disputed, disputed, endpoints: [primaryUrl, confirmUrl] };
}
