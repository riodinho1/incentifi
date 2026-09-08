# Blockscout verification inputs (Robinhood Chain 4663)

Standard-JSON inputs produced by `forge verify-contract --show-standard-json-input …` from the exact `foundry.toml` settings (solc `v0.8.26+commit.8a97fa7a`, optimizer 200 runs, viaIR, cancun). Sourcify already holds **exact matches** for the hook, factory, converter, V2 and swapper; this folder exists because Blockscout's API rate-limits verification submissions per IP ("Too many requests", ~1 per day observed on 2026-09-08), so the remaining two are easiest to finish from the browser.

| Contract | Address | Blockscout status (2026-09-08) | File | Constructor args (ABI-encoded, no 0x) |
|---|---|---|---|---|
| `LossRewardPoolV2` | `0x5d94246CD31064Da02E953DB357F0001F0E9A631` | **verified** (API: "Smart-contract already verified") | `LossRewardPoolV2.standard-input.json` | `00000000000000000000000078a4e4bcc8ab559b6d3b1cb9eab0a04a2411c726` `0000000000000000000000004783c67b63de2b358ac5951a7d41f47a38f3c046` `000000000000000000000000e10b6f6b275de231345c20d14ab812db62151b00` |
| `IncentifiFeeConverter` | `0xe1BB0667d64683072BaeE03D8D9Feb201dcAF7D9` | not verified (submission rate-limited) | `IncentifiFeeConverter.standard-input.json` | `0000000000000000000000008366a39cc670b4001a1121b8f6a443a643e40951` `000000000000000000000000921d0be20a21e5a687734b4df6302ea55bd168c0` |
| `LossRewardPool` (V1) | `0x697BDA9db5a297a9Cd9ED969BBF2549d0527DcdF` | not verified anywhere (submission rate-limited) | `LossRewardPool.standard-input.json` | `00000000000000000000000078a4e4bcc8ab559b6d3b1cb9eab0a04a2411c726` |

**V1 provenance.** `contracts/LossRewardPool.sol` has not changed since it was added in commit `e1a711d` (the deploy commit `c50e4fe` "sync verified Robinhood Mainnet contract addresses" referenced the same file), so the current source is the deployed source. The compiler settings used at deploy time were not recorded; the input above uses today's `foundry.toml`. If Blockscout reports a bytecode mismatch, the original settings are unrecoverable from the repo and V1 stays unverified (it receives no new deposits since the 2026-09-07 re-point).

## How to submit (browser, avoids the API limit)

1. Open `https://robinhoodchain.blockscout.com/address/<address>?tab=contract` → **Verify & publish**.
2. Method **Solidity (Standard JSON input)**; compiler `v0.8.26+commit.8a97fa7a`; upload the file from this folder.
3. Constructor arguments: paste the hex from the table (Blockscout usually auto-detects them).
4. Alternatively **Verify via Sourcify** for the converter (Sourcify has the exact match).

Re-check with:

```bash
curl -A "Mozilla/5.0" "https://robinhoodchain.blockscout.com/api/v2/smart-contracts/<address>" | jq '{is_verified, is_fully_verified, name}'
```
