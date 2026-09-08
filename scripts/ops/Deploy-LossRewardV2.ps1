<#
.SYNOPSIS
  LossRewardPoolV2 mainnet runbook (Robinhood Chain 4663), one step per invocation.
  docs/LOSS_REWARD_ASSET_DESIGN.md §C9 explains each step; this file is the executable form.

.DESCRIPTION
  Steps, in order (each is a separate invocation; every step re-checks the chain before acting):

    Preflight          read-only. Chain id, hook owner, current loss-reward pool (must still be V1),
                       route pools (token0 == WETH, token1 == asset, fee tier), StockFactory round-trip
                       for AAPL/TSLA/NVDA, registry not paused, owner balance, forge build.
    DeployDryRun       forge script DeployLossRewardPoolV2.s.sol WITHOUT --broadcast (simulation only).
    DeployBroadcast    same script with --broadcast. Deploys V2 + RewardSwapperUniswapV3, sets the three
                       routes, setAssetSetter(legible factory, true), setMinStockReward. Then runs ReadBack.
    ReadBack   -V2     read-only. Every value the deploy was supposed to set, compared to the expected
                       constants below, plus every route in config/loss-reward-stock-routes.json (reported
                       as configured / missing / different). Exit code 1 if anything is off.
    RoutesDryRun -V2   forge script ConfigureStockRoutes.s.sol WITHOUT --broadcast: one setAssetRoute per
                       stock in config/loss-reward-stock-routes.json that is not already configured
                       identically (idempotent). Adapter + StockFactory validate every route in simulation.
    RoutesBroadcast -V2  the same with --broadcast (N owner transactions, N = routes missing/different).
    VerifySource -V2 -Swapper   Sourcify verification of both contracts with the exact foundry.toml settings.
    RepointDryRun -V2  forge script RepointHookLossRewardPool.s.sol WITHOUT --broadcast.
    RepointBroadcast -V2   THE FINAL, SEPARATE ACTION: hook.setLossRewardPool(V2). Reads back hook +
                       converter afterwards. Every deposit after this lands in V2; nothing moves from V1.

  OWNER KEY: never inline, never in history. Steps that broadcast call Read-Host -AsSecureString, derive
  the address, refuse anything but the hook owner, hand the key to forge for that one process, and zero
  the variable. Foundry has no env-var input for a raw key, so the key is on the forge child process's
  command line for the seconds it runs (visible to other processes of YOUR user only). If you would
  rather never have it in a process argument at all: `cast wallet import incentifi-owner --interactive`
  once (encrypted keystore, prompt is Foundry's own) and pass `-UseKeystore incentifi-owner`. The
  keystore PASSWORD is then what Read-Host -AsSecureString collects; it is written to a temp file
  readable only by your user (no BOM, no newline), handed to forge as `--password-file <path>`, and
  the file is deleted afterwards. (forge's ETH_PASSWORD env var is the password FILE PATH, not the
  password - passing the password through it fails with "Keystore password file does not exist".)
  `-KeystorePasswordFile <path>` skips the prompt and uses your own file (forge's native mechanism);
  that file is left alone. With -UseKeystore the DRY-RUN steps unlock the keystore too, so a dry run
  proves the exact wallet arguments the broadcast will use. Before anything is sent the keystore is
  unlocked once with `cast wallet address` and must resolve to the hook owner.

  Nothing here reads .env.local. Nothing here touches Supabase. The operator (worker) key is not needed.

.EXAMPLE
  .\scripts\ops\Deploy-LossRewardV2.ps1 -Step Preflight
  .\scripts\ops\Deploy-LossRewardV2.ps1 -Step DeployDryRun
  .\scripts\ops\Deploy-LossRewardV2.ps1 -Step DeployBroadcast
  .\scripts\ops\Deploy-LossRewardV2.ps1 -Step ReadBack -V2 0x...
  .\scripts\ops\Deploy-LossRewardV2.ps1 -Step VerifySource -V2 0x... -Swapper 0x...
  .\scripts\ops\Deploy-LossRewardV2.ps1 -Step RoutesDryRun -V2 0x...
  .\scripts\ops\Deploy-LossRewardV2.ps1 -Step RoutesBroadcast -V2 0x...
  # ... set LOSS_REWARD_POOL_V2_ADDRESS on the worker + gateway, VITE_LOSS_REWARD_POOL_V2 on the frontend,
  # ... confirm supabase/loss_reward_v2_migration.sql is applied, THEN:
  .\scripts\ops\Deploy-LossRewardV2.ps1 -Step RepointDryRun -V2 0x...
  .\scripts\ops\Deploy-LossRewardV2.ps1 -Step RepointBroadcast -V2 0x...
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Preflight', 'DeployDryRun', 'DeployBroadcast', 'ReadBack', 'VerifySource', 'RoutesDryRun', 'RoutesBroadcast', 'RepointDryRun', 'RepointBroadcast')]
  [string]$Step,
  [string]$V2 = '',
  [string]$Swapper = '',
  [string]$Rpc = 'https://rpc.mainnet.chain.robinhood.com',
  [string]$UseKeystore = '',
  [string]$KeystorePasswordFile = ''
)

# 'Continue', not 'Stop': forge/cast write notes to stderr (e.g. "note[multi-contract-file]") and with
# 'Stop' PowerShell 5.1 turns every such line into a terminating NativeCommandError. Every native call
# below checks $LASTEXITCODE (or throws) explicitly instead.
$ErrorActionPreference = 'Continue'
Set-StrictMode -Version 2

# ---------------------------------------------------------------------------------------------
# Expected constants. Every address was read back on-chain on 2026-09-07 (docs §A, §12, §C9).
# If any of these is wrong the read-back FAILS loudly rather than the deploy proceeding quietly.
# ---------------------------------------------------------------------------------------------
$CHAIN_ID          = 4663
$OWNER             = '0x78a4E4BCC8ab559B6d3B1Cb9eab0A04a2411c726'   # hook owner == V1 operator == worker operator
$HOOK              = '0x921d0bE20A21e5A687734b4dF6302EA55BD168C0'
$LEGIBLE_FACTORY   = '0xD4ce8F9577F3a865C3bA0c9d156f2b615df89Dda'   # the ASSET_SETTER
$FEE_CONVERTER     = '0xe1BB0667d64683072BaeE03D8D9Feb201dcAF7D9'
$V1                = '0x697BDA9db5a297a9Cd9ED969BBF2549d0527DcdF'
$STOCK_FACTORY     = '0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046'
$ACCESS_REGISTRY   = '0xe10b6f6B275de231345c20D14Ab812db62151b00'
$WETH              = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'
$UNISWAP_V3_FACTORY= '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA'
$OPERATOR          = $OWNER
$MIN_STOCK_REWARD_WEI = '2000000000000000'                          # 0.002 ETH, applies to a claimBatchAs TOTAL
$TWAP_WINDOW       = 1800                                            # seconds (>= MIN_TWAP_WINDOW 300)
$MAX_DEVIATION_BPS = 300                                             # 3% (<= MAX_DEVIATION_BPS_CAP 2000)
$ROUTES = @(
  @{ Symbol = 'AAPL'; Asset = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9'; Pool = '0x8bb3514e2204E1cDF3Ac149EFEe7Ff04D91B719f'; Fee = 500  }
  @{ Symbol = 'TSLA'; Asset = '0x322F0929c4625eD5bAd873c95208D54E1c003b2d'; Pool = '0xA953CA88ff430e9487c60cA34d757414f4efdA07'; Fee = 3000 }
  @{ Symbol = 'NVDA'; Asset = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC'; Pool = '0x62AB521f71431f78ac374CdbadC6cda3c8916b6C'; Fee = 500  }
)
$DEPLOY_SCRIPT  = 'script/DeployLossRewardPoolV2.s.sol'
$ROUTES_SCRIPT  = 'script/ConfigureStockRoutes.s.sol'
$ROUTES_FILE    = 'config/loss-reward-stock-routes.json'   # generated by scripts/ops/generate-stock-routes.mjs
$REPOINT_SCRIPT = 'script/RepointHookLossRewardPool.s.sol'
$BROADCAST_JSON = 'broadcast/DeployLossRewardPoolV2.s.sol/4663/run-latest.json'

# ---------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------
$foundryBin = Join-Path $env:USERPROFILE '.foundry\bin'
if (Test-Path $foundryBin) { $env:PATH = "$env:PATH;$foundryBin" }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repoRoot

$script:failures = 0
function Pass($msg) { Write-Host ("  PASS  " + $msg) -ForegroundColor Green }
function Fail($msg) { $script:failures++; Write-Host ("  FAIL  " + $msg) -ForegroundColor Red }
function Info($msg) { Write-Host ("        " + $msg) -ForegroundColor DarkGray }
function Head($msg) { Write-Host ""; Write-Host ("== " + $msg) -ForegroundColor Cyan }
function Same($a, $b) { return ($a.ToString().Trim().ToLower() -eq $b.ToString().Trim().ToLower()) }
function Clean($s) { return (($s | Out-String).Trim() -replace '\s*\[[^\]]*\]\s*$', '') }   # strip cast's " [1.8e3]" suffix
function Check($label, $actual, $expected) {
  if (Same $actual $expected) { Pass "$label = $actual" } else { Fail "$label = '$actual' (expected '$expected')" }
}
function CastCall($to, $sig) {
  $out = & cast call $to $sig --rpc-url $Rpc 2>&1
  if ($LASTEXITCODE -ne 0) { throw "cast call $to $sig failed: $out" }
  return (Clean $out)
}
function CastCallArgs($to, $sig, [string[]]$callArgs) {
  $out = & cast call $to $sig @callArgs --rpc-url $Rpc 2>&1
  if ($LASTEXITCODE -ne 0) { throw "cast call $to $sig $callArgs failed: $out" }
  return (Clean $out)
}
function RequireAddress($value, $name) {
  if (-not ($value -match '^0x[0-9a-fA-F]{40}$')) { throw "-$name must be a 0x-prefixed 20-byte address (got '$value')" }
}
function ExitWithSummary() {
  if ($script:failures -gt 0) { Write-Host ""; Write-Host "$($script:failures) check(s) FAILED - do not continue to the next step." -ForegroundColor Red; exit 1 }
  Write-Host ""; Write-Host "All checks passed." -ForegroundColor Green
}

# Owner key: Read-Host -AsSecureString, derive the address, refuse anything but $OWNER.
# Returns the plaintext for the caller to pass to ONE forge/cast invocation, then Clear-Key.
function Get-OwnerKeyPlain() {
  $sec = Read-Host -AsSecureString "Hook owner private key ($OWNER) - typed input is hidden"
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($sec)
  try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringUni($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($ptr) }
  $plain = $plain.Trim()
  if (-not $plain.StartsWith('0x')) { $plain = '0x' + $plain }
  if (-not ($plain -match '^0x[0-9a-fA-F]{64}$')) { throw 'That is not a 32-byte hex private key. Nothing was sent.' }
  $addr = (& cast wallet address --private-key $plain 2>&1 | Out-String).Trim()
  if (-not (Same $addr $OWNER)) { throw "That key controls $addr, not the hook owner $OWNER. Nothing was sent." }
  Info "key controls $addr (hook owner) - OK"
  return $plain
}
# Keystore password -> a file only the current user can read, for forge's --password-file.
# (ETH_PASSWORD is the *file path* variable in forge; there is no env var for the password itself.)
function New-KeystorePasswordFile() {
  if ($KeystorePasswordFile -ne '') {
    if (-not (Test-Path -LiteralPath $KeystorePasswordFile)) { throw "-KeystorePasswordFile '$KeystorePasswordFile' does not exist." }
    Info "keystore password file: $KeystorePasswordFile (yours; not deleted)"
    return (Resolve-Path -LiteralPath $KeystorePasswordFile).Path
  }
  $sec = Read-Host -AsSecureString "Password for Foundry keystore '$UseKeystore' - typed input is hidden"
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($sec)
  try { $pw = [Runtime.InteropServices.Marshal]::PtrToStringUni($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($ptr) }
  if ($pw -eq $null -or $pw.Length -eq 0) { throw 'Empty keystore password. Nothing was sent.' }
  $path = Join-Path ([IO.Path]::GetTempPath()) ('incentifi-ks-' + [Guid]::NewGuid().ToString('N') + '.pw')
  # restrict BEFORE writing: owner-only ACL, no inheritance
  New-Item -ItemType File -Path $path -Force | Out-Null
  $acl = Get-Acl -LiteralPath $path
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($r in @($acl.Access)) { [void]$acl.RemoveAccessRule($r) }
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))
  Set-Acl -LiteralPath $path -AclObject $acl
  [IO.File]::WriteAllText($path, $pw, (New-Object Text.UTF8Encoding($false)))   # no BOM, no trailing newline
  $pw = $null
  $script:tempPasswordFile = $path
  Info "keystore password written to $path (owner-only ACL; deleted after this step)"
  return $path
}
# Wallet arguments for a forge/cast command. Either path resolves to the same --sender ($OWNER) and is
# refused otherwise. Used by the broadcast steps, and by the dry runs when -UseKeystore is given.
function Get-WalletArgs() {
  if ($UseKeystore -ne '') {
    $pwFile = New-KeystorePasswordFile
    $addr = (& cast wallet address --account $UseKeystore --password-file $pwFile 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not ($addr -match '^0x[0-9a-fA-F]{40}$')) { Clear-Key; throw "Could not unlock keystore '$UseKeystore' with that password: $addr" }
    if (-not (Same $addr $OWNER)) { Clear-Key; throw "Keystore '$UseKeystore' controls $addr, not the hook owner $OWNER. Nothing was sent." }
    Info "keystore '$UseKeystore' unlocks to $addr (hook owner) - OK"
    return @('--account', $UseKeystore, '--password-file', $pwFile, '--sender', $OWNER)
  }
  $script:ownerKeyPlain = Get-OwnerKeyPlain
  return @('--private-key', $script:ownerKeyPlain, '--sender', $OWNER)
}
function Clear-Key() {
  if (Get-Variable -Name ownerKeyPlain -Scope Script -ErrorAction SilentlyContinue) { $script:ownerKeyPlain = $null; Remove-Variable -Name ownerKeyPlain -Scope Script -ErrorAction SilentlyContinue }
  if (Get-Variable -Name tempPasswordFile -Scope Script -ErrorAction SilentlyContinue) {
    if ($script:tempPasswordFile -and (Test-Path -LiteralPath $script:tempPasswordFile)) {
      # overwrite, then delete
      [IO.File]::WriteAllText($script:tempPasswordFile, ('0' * 64), (New-Object Text.UTF8Encoding($false)))
      Remove-Item -LiteralPath $script:tempPasswordFile -Force
      Info "deleted $($script:tempPasswordFile)"
    }
    Remove-Variable -Name tempPasswordFile -Scope Script -ErrorAction SilentlyContinue
  }
  [GC]::Collect()
}
# Sender arguments for a simulation: with -UseKeystore the keystore is unlocked exactly as the
# broadcast will do it (so the dry run tests the wallet path too); otherwise just --sender.
function Get-DryRunSenderArgs() {
  if ($UseKeystore -ne '') { return (Get-WalletArgs) }
  return @('--sender', $OWNER)
}
# Typed confirmation gates. FAIL CLOSED: Confirm-Typed records the word it accepted, and every
# broadcast step calls Assert-Gate with the same word right before it asks for the wallet. If the
# Confirm-Typed statement was skipped for any reason (e.g. its prompt string failed to evaluate -
# PowerShell parses "$V2?" as a variable named V2? and, under Set-StrictMode, throws; with
# $ErrorActionPreference = 'Continue' that error is printed and execution moves on), Assert-Gate throws
# and nothing is broadcast. Interpolate a variable followed by ? : ! or [ as ${Var}.
$script:gatePassed = ''
function Confirm-Typed($word, $prompt) {
  $script:gatePassed = ''
  $typed = Read-Host "$prompt Type $word to continue"
  if ($typed -ne $word) { throw "Aborted (you typed '$typed')." }
  $script:gatePassed = $word
}
function Assert-Gate($word) {
  if ($script:gatePassed -ne $word) { throw "Confirmation gate '$word' was not passed (the prompt was skipped or answered wrongly). Nothing was sent." }
  $script:gatePassed = ''
}

# ---------------------------------------------------------------------------------------------
# shared read-only checks
# ---------------------------------------------------------------------------------------------
function Check-Chain() {
  Head "Chain + hook state"
  $cid = Clean (& cast chain-id --rpc-url $Rpc)
  Check 'chain id' $cid $CHAIN_ID
  Check 'hook.owner()' (CastCall $HOOK 'owner()(address)') $OWNER
  Check 'legibleFactory.hook()' (CastCall $LEGIBLE_FACTORY 'hook()(address)') $HOOK
  Check 'converter.hook()' (CastCall $FEE_CONVERTER 'hook()(address)') $HOOK
  $script:hookPool = CastCall $HOOK 'lossRewardPool()(address)'
  $convPool = CastCall $FEE_CONVERTER 'lossRewardPool()(address)'
  Check 'converter.lossRewardPool() == hook.lossRewardPool()' $convPool $script:hookPool
  Info "hook.lossRewardPool() = $($script:hookPool)"
  $bal = Clean (& cast balance $OWNER --rpc-url $Rpc --ether)
  Info "owner balance = $bal ETH (gas payer for every step; the dry run prints the estimated cost - keep >= 3x that)"
  if ([double]$bal -lt 0.003) { Fail "owner balance $bal ETH looks too low to deploy V2 + swapper + 5 config txs" } else { Pass "owner balance $bal ETH" }
}
function Check-Routes() {
  Head "Route venues (Uniswap V3 WETH pools) + StockFactory registry"
  Check 'registry.paused()' (CastCall $ACCESS_REGISTRY 'paused()(bool)') 'false'
  foreach ($r in $ROUTES) {
    $t0 = CastCall $r.Pool 'token0()(address)'
    $t1 = CastCall $r.Pool 'token1()(address)'
    $fee = CastCall $r.Pool 'fee()(uint24)'
    Check "$($r.Symbol) pool.token0 (WETH)" $t0 $WETH
    Check "$($r.Symbol) pool.token1 (asset)" $t1 $r.Asset
    Check "$($r.Symbol) pool.fee" $fee $r.Fee
    $factoryPool = CastCallArgs $UNISWAP_V3_FACTORY 'getPool(address,address,uint24)(address)' @($WETH, $r.Asset, "$($r.Fee)")
    Check "$($r.Symbol) v3Factory.getPool(WETH, asset, fee) is the canonical pool" $factoryPool $r.Pool
    $uid = CastCall $r.Asset 'uid()(bytes32)'
    $roundTrip = CastCallArgs $STOCK_FACTORY 'tokenAddress(bytes32)(address)' @($uid)
    Check "$($r.Symbol) StockFactory.tokenAddress(uid) round-trip" $roundTrip $r.Asset
    $sym = CastCall $r.Asset 'symbol()(string)'
    Info "$($r.Symbol) symbol() = $sym, uid = $uid"
  }
}
function Read-Back($v2) {
  RequireAddress $v2 'V2'
  Head "LossRewardPoolV2 read-back @ $v2"
  $code = Clean (& cast code $v2 --rpc-url $Rpc)
  if ($code.Length -le 4) { Fail "no code at $v2"; return }
  Pass "code present ($([int](($code.Length - 2) / 2)) bytes)"
  Check 'owner()' (CastCall $v2 'owner()(address)') $OWNER
  Check 'operator()' (CastCall $v2 'operator()(address)') $OPERATOR
  Check 'stockFactory()' (CastCall $v2 'stockFactory()(address)') $STOCK_FACTORY
  Check 'accessRegistry()' (CastCall $v2 'accessRegistry()(address)') $ACCESS_REGISTRY
  Check 'minStockRewardWei()' (CastCall $v2 'minStockRewardWei()(uint256)') $MIN_STOCK_REWARD_WEI
  Check "assetSetters(legible factory $LEGIBLE_FACTORY)" (CastCallArgs $v2 'assetSetters(address)(bool)' @($LEGIBLE_FACTORY)) 'true'
  Check 'assetSetters(owner) (should NOT be a setter)' (CastCallArgs $v2 'assetSetters(address)(bool)' @($OWNER)) 'false'
  $swapperSeen = ''
  foreach ($r in $ROUTES) {
    $raw = CastCallArgs $v2 'assetRoute(address)((address,address,uint24,uint32,uint16,bool))' @($r.Asset)
    # cast prints: (0xSwapper, 0xPool, 500, 1800, 300, true)
    $parts = ($raw.Trim('(', ')') -split ',') | ForEach-Object { ($_ -replace '\[[^\]]*\]', '').Trim() }
    if ($parts.Count -ne 6) { Fail "$($r.Symbol) assetRoute() unparsable: $raw"; continue }
    if ($swapperSeen -eq '') { $swapperSeen = $parts[0] } elseif (-not (Same $swapperSeen $parts[0])) { Fail "$($r.Symbol) route uses a different swapper ($($parts[0])) than the others ($swapperSeen)" }
    Check "$($r.Symbol) route.pool" $parts[1] $r.Pool
    Check "$($r.Symbol) route.fee" $parts[2] $r.Fee
    Check "$($r.Symbol) route.twapWindow" $parts[3] $TWAP_WINDOW
    Check "$($r.Symbol) route.maxDeviationBps" $parts[4] $MAX_DEVIATION_BPS
    Check "$($r.Symbol) route.enabled" $parts[5] 'true'
    Check "$($r.Symbol) isSelectableAsset()" (CastCallArgs $v2 'isSelectableAsset(address)(bool)' @($r.Asset)) 'true'
  }
  if (Test-Path $ROUTES_FILE) {
    Head "All stock routes in $ROUTES_FILE"
    $cfg = Get-Content $ROUTES_FILE -Raw | ConvertFrom-Json
    $ok = 0; $missing = @(); $different = @(); $notSel = @()
    foreach ($r in $cfg.routes) {
      $raw = CastCallArgs $v2 'assetRoute(address)((address,address,uint24,uint32,uint16,bool))' @($r.asset)
      $parts = ($raw.Trim('(', ')') -split ',') | ForEach-Object { ($_ -replace '\[[^\]]*\]', '').Trim() }
      if ($parts.Count -ne 6 -or (Same $parts[0] '0x0000000000000000000000000000000000000000')) { $missing += $r.symbol; continue }
      if (-not ((Same $parts[1] $r.pool) -and (Same $parts[2] $r.fee) -and (Same $parts[3] $cfg.twapWindow) -and (Same $parts[4] $cfg.maxDeviationBps) -and (Same $parts[5] 'true'))) { $different += "$($r.symbol) (on-chain pool $($parts[1]) fee $($parts[2]) twap $($parts[3]) dev $($parts[4]) enabled $($parts[5]))"; continue }
      if (-not (Same (CastCallArgs $v2 'isSelectableAsset(address)(bool)' @($r.asset)) 'true')) { $notSel += $r.symbol }
      $ok++
      Start-Sleep -Milliseconds 150
    }
    Info "routes in file: $($cfg.count) (generated $($cfg.generatedAt) from chain head $($cfg.source.chainHead))"
    if ($ok -eq $cfg.count) { Pass "all $ok routes configured exactly as in the file" } else { Pass "$ok/$($cfg.count) routes configured as in the file" }
    if ($missing.Count -gt 0) { Info "not configured yet ($($missing.Count)): $($missing -join ' ')  -> run -Step RoutesDryRun / RoutesBroadcast" }
    if ($different.Count -gt 0) { Fail "configured DIFFERENTLY from the file ($($different.Count)): $($different -join '; ')  -> regenerate the file or re-run RoutesBroadcast deliberately" }
    if ($notSel.Count -gt 0) { Info "configured but not selectable right now ($($notSel.Count)): $($notSel -join ' ')  (asset paused or registry changed - live condition)" }
    $script:routesMissing = $missing.Count
  } else { Info "$ROUTES_FILE not found - only the three baseline routes were checked" }
  if ($swapperSeen -ne '') {
    Head "RewardSwapperUniswapV3 read-back @ $swapperSeen"
    $script:swapperFromChain = $swapperSeen
    Check 'swapper.lossRewardPool()' (CastCall $swapperSeen 'lossRewardPool()(address)') $v2
    Check 'swapper.weth()' (CastCall $swapperSeen 'weth()(address)') $WETH
    Check 'swapper.v3Factory()' (CastCall $swapperSeen 'v3Factory()(address)') $UNISWAP_V3_FACTORY
    Check 'swapper.validateRoute(AAPL, pool, 500)' (CastCallArgs $swapperSeen 'validateRoute(address,address,uint24)(bool)' @($ROUTES[0].Asset, $ROUTES[0].Pool, '500')) 'true'
  }
  Head "Hook still points at V1 (re-point is a separate step)"
  $hp = CastCall $HOOK 'lossRewardPool()(address)'
  if (Same $hp $V1) { Pass "hook.lossRewardPool() = $hp (V1) - not yet re-pointed, as expected before RepointBroadcast" }
  elseif (Same $hp $v2) { Pass "hook.lossRewardPool() = $hp (this V2) - already re-pointed" }
  else { Fail "hook.lossRewardPool() = $hp is neither V1 nor this V2" }
  Info "V2 is funded only by depositReward(token) from the converter after the re-point; bare ETH transfers to V2 or the swapper revert."
}
function Set-DeployEnv() {
  $env:OPERATOR = $OPERATOR
  $env:ASSET_SETTER = $LEGIBLE_FACTORY
  $env:MIN_STOCK_REWARD_WEI = $MIN_STOCK_REWARD_WEI
  Info "env: OPERATOR=$env:OPERATOR ASSET_SETTER=$env:ASSET_SETTER MIN_STOCK_REWARD_WEI=$env:MIN_STOCK_REWARD_WEI"
  Info "constants in the script (not env): STOCK_FACTORY, ACCESS_REGISTRY, WETH, UNISWAP_V3_FACTORY, the three assets/pools/fee tiers, TWAP_WINDOW=$TWAP_WINDOW, MAX_DEVIATION_BPS=$MAX_DEVIATION_BPS"
}
function Expect-InOutput($text, $pattern, $label) {
  if ($text -match $pattern) { Pass $label } else { Fail "$label - not found in forge output" }
}
function Parse-DeployBroadcast() {
  if (-not (Test-Path $BROADCAST_JSON)) { Fail "no broadcast record at $BROADCAST_JSON"; return $null }
  $j = Get-Content $BROADCAST_JSON -Raw | ConvertFrom-Json
  $out = @{ V2 = ''; Swapper = ''; Hashes = @() }
  foreach ($tx in $j.transactions) {
    $out.Hashes += $tx.hash
    if ($tx.transactionType -eq 'CREATE' -and $tx.contractName -eq 'LossRewardPoolV2') { $out.V2 = $tx.contractAddress }
    if ($tx.transactionType -eq 'CREATE' -and $tx.contractName -eq 'RewardSwapperUniswapV3') { $out.Swapper = $tx.contractAddress }
  }
  foreach ($rc in $j.receipts) { if ($rc.status -ne '0x1') { Fail "receipt $($rc.transactionHash) status $($rc.status) (reverted)" } }
  return $out
}

# ---------------------------------------------------------------------------------------------
# steps
# ---------------------------------------------------------------------------------------------
switch ($Step) {

  'Preflight' {
    Head "Toolchain + tree"
    $fv = (& forge --version 2>&1 | Select-Object -First 1); Info "$fv"
    $branch = (& git rev-parse --abbrev-ref HEAD).Trim(); $head = (& git rev-parse --short HEAD).Trim()
    $dirty = (& git status --porcelain -- contracts script foundry.toml | Out-String).Trim()
    Info "branch $branch @ $head"
    if ($dirty -ne '') { Fail "contracts/, script/ or foundry.toml have uncommitted changes - deploy from a clean, merged commit so the verified source matches" } else { Pass "contracts/ script/ foundry.toml clean" }
    if ($branch -ne 'master') { Info "WRONG looks like: deploying from a feature branch. Merge first; the broadcast record is committed to master." }
    $build = & forge build 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { Write-Host $build; Fail "forge build failed" } else { Pass "forge build" }
    Check-Chain
    if (-not (Same $script:hookPool $V1)) { Fail "hook.lossRewardPool() is $($script:hookPool), expected V1 $V1 before deploying (already re-pointed? stop and check)" } else { Pass "hook.lossRewardPool() == V1 (not yet re-pointed)" }
    Check-Routes
    Info ""
    Info "Off-chain prerequisites you confirm by hand (not checked here):"
    Info "  - supabase/loss_reward_v2_migration.sql applied (reward_epochs.pool_address, tokens.reward_asset*)"
    Info "  - worker + gateway deployed from master with the dual-pool code, LOSS_REWARD_POOL_V2_ADDRESS still UNSET"
    Info "WRONG looks like: chain id != 4663 (wrong RPC), hook.owner != $OWNER (wrong hook address or ownership moved),"
    Info "  a route pool whose token1 != the asset or fee != tier (wrong venue -> setAssetRoute reverts InvalidRoute),"
    Info "  StockFactory round-trip != asset (not a canonical Robinhood token -> AssetNotSelectable), registry paused (claims fall back to ETH)."
    ExitWithSummary
  }

  'DeployDryRun' {
    Check-Chain
    if (-not (Same $script:hookPool $V1)) { Fail "hook already points at $($script:hookPool); stop." ; ExitWithSummary }
    Head "forge script $DEPLOY_SCRIPT (SIMULATION, no --broadcast)"
    Set-DeployEnv
    $senderArgs = Get-DryRunSenderArgs
    try {
      $out = & forge script $DEPLOY_SCRIPT --rpc-url $Rpc @senderArgs 2>&1 | Out-String
    } finally { Clear-Key }
    Write-Host $out
    if ($LASTEXITCODE -ne 0) { Fail "simulation failed (exit $LASTEXITCODE)" }
    Expect-InOutput $out 'LossRewardPoolV2\s+0x[0-9a-fA-F]{40}' 'logs a LossRewardPoolV2 address'
    Expect-InOutput $out 'RewardSwapperUniswapV3\s+0x[0-9a-fA-F]{40}' 'logs a RewardSwapperUniswapV3 address'
    Expect-InOutput $out "owner \(EOA\)\s+$OWNER" "owner (EOA) = $OWNER"
    Expect-InOutput $out "operator\s+$OPERATOR" "operator = $OPERATOR"
    Expect-InOutput $out "assetSetter\s+$LEGIBLE_FACTORY" "assetSetter = legible factory"
    Expect-InOutput $out "minStockRewardWei\s+$MIN_STOCK_REWARD_WEI" "minStockRewardWei = $MIN_STOCK_REWARD_WEI"
    if ($out -match 'WARNING: ASSET_SETTER unset') { Fail 'script warned ASSET_SETTER unset (env not seen by forge)' } else { Pass 'no ASSET_SETTER warning' }
    Expect-InOutput $out 'NEXT \(separate, deliberate\)' 'script reached its final log line (all requires passed)'
    Info ""
    Info "Read the 'Estimated total gas used' / 'Estimated amount required' lines above: 7 transactions (2 CREATE + 3 setAssetRoute + setAssetSetter + setMinStockReward)."
    Info "WRONG looks like: 'assets not selectable' (a route reverted -> venue/fee mismatch or registry hiccup), 'owner mismatch' (sender != $OWNER),"
    Info "  'InvalidRoute' (swapper.validateRoute false: pool not canonical for (WETH, asset, fee)), 'AssetNotSelectable' (StockFactory round-trip failed),"
    Info "  an estimated amount larger than the owner balance."
    ExitWithSummary
  }

  'DeployBroadcast' {
    Check-Chain
    if (-not (Same $script:hookPool $V1)) { Fail "hook already points at $($script:hookPool); stop." ; ExitWithSummary }
    Head "forge script $DEPLOY_SCRIPT --broadcast (REAL MONEY, 7 transactions from $OWNER)"
    Set-DeployEnv
    Confirm-Typed 'DEPLOY-V2' "This deploys LossRewardPoolV2 + swapper and configures them. It does NOT re-point the hook."
    Assert-Gate 'DEPLOY-V2'
    $wallet = Get-WalletArgs
    try {
      $out = & forge script $DEPLOY_SCRIPT --rpc-url $Rpc --broadcast --slow @wallet 2>&1 | Out-String
    } finally { Clear-Key }
    Write-Host ($out -replace '--private-key\s+0x[0-9a-fA-F]{64}', '--private-key <redacted>')
    if ($LASTEXITCODE -ne 0) { Fail "broadcast failed (exit $LASTEXITCODE) - check $BROADCAST_JSON before retrying; a partial deploy leaves a pool with fewer routes, NOT a reason to run twice blindly" }
    $rec = Parse-DeployBroadcast
    if ($rec -ne $null) {
      Info "V2      = $($rec.V2)"
      Info "Swapper = $($rec.Swapper)"
      Info "txs     = $($rec.Hashes -join ', ')"
      if ($rec.V2 -ne '' ) { Read-Back $rec.V2 }
      Info ""
      Info "NEXT: commit $BROADCAST_JSON; run -Step VerifySource -V2 $($rec.V2) -Swapper $($rec.Swapper);"
      Info "      set LOSS_REWARD_POOL_V2_ADDRESS=$($rec.V2) on the worker + gateway, VITE_LOSS_REWARD_POOL_V2=$($rec.V2) on the frontend;"
      Info "      only then -Step RepointDryRun / RepointBroadcast."
    }
    ExitWithSummary
  }

  'ReadBack' {
    RequireAddress $V2 'V2'
    Check-Chain
    Read-Back $V2
    Info "WRONG looks like: assetSetters(factory) = false (stock launches will revert NotAssetSetter; fix: cast send V2 'setAssetSetter(address,bool)' $LEGIBLE_FACTORY true from the owner),"
    Info "  isSelectableAsset = false for an asset whose route reads back correctly (registry paused or round-trip broken RIGHT NOW - re-check later, it is a live condition),"
    Info "  swapper.lossRewardPool != V2 (swapper built against another pool - swaps revert OnlyPool -> every stock claim falls back to ETH with SwapFailed)."
    ExitWithSummary
  }

  'VerifySource' {
    RequireAddress $V2 'V2'
    if ($Swapper -eq '') { Check-Chain; Read-Back $V2; $Swapper = $script:swapperFromChain }
    RequireAddress $Swapper 'Swapper'
    Head "Sourcify verification (exact foundry.toml settings: solc 0.8.26, optimizer 200, viaIR, cancun)"
    $ctorPool = (& cast abi-encode 'constructor(address,address,address)' $OPERATOR $STOCK_FACTORY $ACCESS_REGISTRY | Out-String).Trim()
    $ctorSwap = (& cast abi-encode 'constructor(address,address,address)' $V2 $WETH $UNISWAP_V3_FACTORY | Out-String).Trim()
    & forge verify-contract $V2 contracts/loss-reward/LossRewardPoolV2.sol:LossRewardPoolV2 --chain $CHAIN_ID --verifier sourcify --constructor-args $ctorPool 2>&1 | ForEach-Object { Info $_ }
    if ($LASTEXITCODE -ne 0) { Fail 'V2 sourcify verification did not succeed' } else { Pass 'V2 submitted to Sourcify' }
    & forge verify-contract $Swapper contracts/loss-reward/RewardSwapperUniswapV3.sol:RewardSwapperUniswapV3 --chain $CHAIN_ID --verifier sourcify --constructor-args $ctorSwap 2>&1 | ForEach-Object { Info $_ }
    if ($LASTEXITCODE -ne 0) { Fail 'swapper sourcify verification did not succeed' } else { Pass 'swapper submitted to Sourcify' }
    Info "Check: https://sourcify.dev/server/v2/contract/$CHAIN_ID/$V2 and .../$Swapper report 'exact_match' (creation + runtime)."
    Info "Blockscout ('Verify via Sourcify' on the address page) is a mirror; its API rate-limits, Sourcify is the one that counts."
    Info "WRONG looks like: 'partial match' (metadata/settings drift - you built from a different commit than the one deployed) or bytecode mismatch (wrong constructor args)."
    ExitWithSummary
  }

  'RoutesDryRun' {
    RequireAddress $V2 'V2'
    if (-not (Test-Path $ROUTES_FILE)) { throw "$ROUTES_FILE missing - run: node scripts/ops/enumerate-stock-venues.mjs --out <venues.json> ; node scripts/ops/generate-stock-routes.mjs --in <venues.json>" }
    Check-Chain
    Read-Back $V2
    if ($script:failures -gt 0) { ExitWithSummary }
    Head "forge script $ROUTES_SCRIPT (SIMULATION, no --broadcast)"
    $env:POOL = $V2; $env:ROUTES_FILE = $ROUTES_FILE
    if ($script:swapperFromChain) { $env:SWAPPER = $script:swapperFromChain }
    Info "env: POOL=$env:POOL SWAPPER=$env:SWAPPER ROUTES_FILE=$env:ROUTES_FILE"
    $senderArgs = Get-DryRunSenderArgs
    try {
      $out = & forge script $ROUTES_SCRIPT --rpc-url $Rpc @senderArgs 2>&1 | Out-String
    } finally { Clear-Key }
    Write-Host $out
    if ($LASTEXITCODE -ne 0) { Fail "simulation failed (exit $LASTEXITCODE)" }
    Expect-InOutput $out 'routes set\s+\d+' 'logs the number of routes to set'
    Expect-InOutput $out 'routes already current \(skipped\)\s+\d+' 'logs the number already current'
    if ($out -match 'not selectable\s+0\b') { Pass 'every listed asset selectable after configuration' } else { Info 'some assets not selectable after configuration - see the NOT selectable lines (paused asset or registry change; the route is still set)' }
    Info "WRONG looks like: RouteRejectedByAdapter(symbol, asset, pool, fee) (the file's pool is not the canonical V3 WETH/asset pool for that tier - regenerate the file),"
    Info "  AssetNotSelectable (StockFactory round-trip failed for that asset), 'sender is not the pool owner', NoSwapper (pass SWAPPER or configure one route first)."
    ExitWithSummary
  }

  'RoutesBroadcast' {
    RequireAddress $V2 'V2'
    if (-not (Test-Path $ROUTES_FILE)) { throw "$ROUTES_FILE missing" }
    Check-Chain
    Read-Back $V2
    if ($script:failures -gt 0) { ExitWithSummary }
    $cfg = Get-Content $ROUTES_FILE -Raw | ConvertFrom-Json
    Head "forge script $ROUTES_SCRIPT --broadcast (REAL MONEY: one setAssetRoute per missing/different route, up to $($cfg.count) transactions from $OWNER)"
    $env:POOL = $V2; $env:ROUTES_FILE = $ROUTES_FILE
    if ($script:swapperFromChain) { $env:SWAPPER = $script:swapperFromChain }
    Confirm-Typed 'SET-ROUTES' "Configure the stock routes from ${ROUTES_FILE} on ${V2}?"
    Assert-Gate 'SET-ROUTES'
    $wallet = Get-WalletArgs
    try {
      $out = & forge script $ROUTES_SCRIPT --rpc-url $Rpc --broadcast --slow @wallet 2>&1 | Out-String
    } finally { Clear-Key }
    Write-Host ($out -replace '--private-key\s+0x[0-9a-fA-F]{64}', '--private-key <redacted>')
    if ($LASTEXITCODE -ne 0) { Fail "broadcast failed (exit $LASTEXITCODE) - re-run RoutesDryRun: the script is idempotent and only resends what is still missing" }
    Head "Post read-back"
    $script:failures = 0
    Read-Back $V2
    if ($script:routesMissing -gt 0) { Fail "$($script:routesMissing) route(s) still missing after broadcast" }
    Info "Commit broadcast/ConfigureStockRoutes.s.sol/4663/run-latest.json."
    ExitWithSummary
  }

  'RepointDryRun' {
    RequireAddress $V2 'V2'
    Check-Chain
    Read-Back $V2
    if ($script:failures -gt 0) { ExitWithSummary }
    Head "forge script $REPOINT_SCRIPT (SIMULATION, no --broadcast)"
    $env:HOOK = $HOOK; $env:NEW_POOL = $V2
    Info "env: HOOK=$env:HOOK NEW_POOL=$env:NEW_POOL"
    $senderArgs = Get-DryRunSenderArgs
    try {
      $out = & forge script $REPOINT_SCRIPT --rpc-url $Rpc @senderArgs 2>&1 | Out-String
    } finally { Clear-Key }
    Write-Host $out
    if ($LASTEXITCODE -ne 0) { Fail "simulation failed (exit $LASTEXITCODE)" }
    Expect-InOutput $out "lossRewardPool BEFORE\s+$V1" "BEFORE = V1 $V1"
    Expect-InOutput $out "lossRewardPool AFTER \(requested\)\s+$V2" "AFTER (requested) = $V2"
    Expect-InOutput $out 're-pointed; converter now deposits to' 'post-condition require passed in simulation'
    Info "WRONG looks like: NotHookOwner(owner, sender) (sender is not $OWNER), NewPoolHasNoCode (typo in -V2), NewPoolNotConfigured (V2 owner/operator zero - wrong address),"
    Info "  BEFORE != V1 (someone already re-pointed - stop and find out where)."
    ExitWithSummary
  }

  'RepointBroadcast' {
    RequireAddress $V2 'V2'
    Check-Chain
    Read-Back $V2
    if ($script:failures -gt 0) { ExitWithSummary }
    Head "FINAL, SEPARATE ACTION: hook.setLossRewardPool($V2) --broadcast (1 transaction from $OWNER)"
    Info "After this, every convert() on the legible converter deposits into V2. Nothing in V1 moves; the worker drains V1 per token"
    Info "(publishing on V1 capped to its remainder) and then publishes on V2. Irreversible in practice: pointing back at V1 later would"
    Info "leave V2 with the same stranding problem in reverse."
    Confirm-Typed 'MIGRATION-APPLIED' "Is supabase/loss_reward_v2_migration.sql applied (reward_epochs.pool_address exists)?"
    Assert-Gate 'MIGRATION-APPLIED'
    Confirm-Typed 'WORKER-HAS-V2' "Is LOSS_REWARD_POOL_V2_ADDRESS=${V2} set on the running worker AND the gateway, VITE_LOSS_REWARD_POOL_V2 on the frontend?"
    Assert-Gate 'WORKER-HAS-V2'
    Confirm-Typed 'REPOINT' "Send hook.setLossRewardPool(${V2}) now?"
    Assert-Gate 'REPOINT'
    $env:HOOK = $HOOK; $env:NEW_POOL = $V2
    $wallet = Get-WalletArgs
    try {
      $out = & forge script $REPOINT_SCRIPT --rpc-url $Rpc --broadcast @wallet 2>&1 | Out-String
    } finally { Clear-Key }
    Write-Host ($out -replace '--private-key\s+0x[0-9a-fA-F]{64}', '--private-key <redacted>')
    if ($LASTEXITCODE -ne 0) { Fail "broadcast failed (exit $LASTEXITCODE)" }
    Head "Post re-point read-back"
    Check 'hook.lossRewardPool()' (CastCall $HOOK 'lossRewardPool()(address)') $V2
    Check 'converter.lossRewardPool() (reads the hook)' (CastCall $FEE_CONVERTER 'lossRewardPool()(address)') $V2
    $rj = 'broadcast/RepointHookLossRewardPool.s.sol/4663/run-latest.json'
    if (Test-Path $rj) {
      $j = Get-Content $rj -Raw | ConvertFrom-Json
      foreach ($tx in $j.transactions) { Info "tx $($tx.hash)  to $($tx.contractAddress)  $($tx.function)" }
      foreach ($rc in $j.receipts) {
        if ($rc.status -eq '0x1') { Pass "receipt $($rc.transactionHash) status 0x1 in block $([Convert]::ToInt64($rc.blockNumber, 16))" } else { Fail "receipt $($rc.transactionHash) status $($rc.status)" }
        $topic0 = (& cast keccak 'LossRewardPoolUpdated(address,address)' | Out-String).Trim()
        $evt = @($rc.logs | Where-Object { $_.topics[0] -eq $topic0 })
        if ($evt.Count -eq 1) { Pass "LossRewardPoolUpdated emitted: old $($evt[0].topics[1]) -> new $($evt[0].topics[2])" } else { Fail "LossRewardPoolUpdated event not found in the receipt" }
      }
    }
    Info ""
    Info "Verify over the next day: the first convert() after this shows V2.totalDeposited(token) > 0 and a RewardDeposited log on V2 (not V1);"
    Info "  the worker log shows '[POOL SELECT] ... -> V1 ... (v1_can_fund | v1_drain_capped)' while a token's V1 remainder lasts, then '(v1_drained)' -> V2;"
    Info "  'pending_funding' rows should stop appearing for re-pointed tokens; fallback monitor quiet (no SwapFailed/BelowProtocolBound bursts)."
    Info "WRONG looks like: converter.lossRewardPool != V2 (converter reads the hook - a mismatch means you re-pointed a different hook),"
    Info "  V1.totalDeposited still growing after the re-point (a second converter/hook is still live), or claims reverting on the site"
    Info "  (VITE_LOSS_REWARD_POOL_V2 unset -> frontend refuses V2 epochs rather than guessing)."
    Info "Then commit $rj and flip VITE_STOCK_REWARDS_ENABLED=true when you are ready to open stock-asset launches."
    ExitWithSummary
  }
}
