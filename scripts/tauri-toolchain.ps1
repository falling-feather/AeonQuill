param(
  [ValidateSet('check', 'debug', 'release', 'bundle', 'bundle-existing')]
  [string]$Mode = 'check'
)

$ErrorActionPreference = 'Stop'
$aeonquillProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$aeonquillVsShell = 'C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\Tools\Launch-VsDevShell.ps1'
if (-not (Test-Path -LiteralPath $aeonquillVsShell -PathType Leaf)) {
  throw 'Visual Studio 2022 C++ Build Tools were not found.'
}

& $aeonquillVsShell -Arch amd64 -HostArch amd64 -SkipAutomaticLocation

# Launch-VsDevShell changes terminal encoding on this machine, so resolve the
# Unicode workspace paths only after the MSVC environment has been loaded.
$aeonquillRustRoot = (Resolve-Path (Join-Path $aeonquillProjectRoot '.runtime\toolchains\rust')).Path
$env:RUSTUP_HOME = Join-Path $aeonquillRustRoot 'rustup'
$env:CARGO_HOME = Join-Path $aeonquillRustRoot 'cargo'
$env:PATH = "$(Join-Path $env:CARGO_HOME 'bin');$env:PATH"
$aeonquillCargo = Join-Path $env:CARGO_HOME 'bin\cargo.exe'
$aeonquillManifest = Join-Path $aeonquillProjectRoot 'desktop\tauri\src-tauri\Cargo.toml'
$aeonquillTauriCli = Join-Path $aeonquillProjectRoot 'node_modules\@tauri-apps\cli\tauri.js'
$aeonquillOfflineTauriCli = Join-Path $aeonquillProjectRoot '.runtime\toolchains\tauri-offline-patch\target\release\cargo-tauri.exe'
$aeonquillOfflineTauriCliSha256 = '3ED4C56DE9F5FC1F98D2C335A88D0E871AB5389EE27FC047EC290E4BC2B60009'

function Get-AeonquillSha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)

  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '')
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

if (-not (Test-Path -LiteralPath $aeonquillCargo -PathType Leaf)) {
  throw 'Project-local Rust toolchain is missing. Install it under .runtime/toolchains/rust first.'
}
if (-not (Test-Path -LiteralPath $aeonquillTauriCli -PathType Leaf)) {
  throw '@tauri-apps/cli is not installed.'
}

$aeonquillUseOfflineTauriCli = -not [string]::IsNullOrWhiteSpace($env:AEONQUILL_WEBVIEW2_OFFLINE_INSTALLER)
if ($aeonquillUseOfflineTauriCli) {
  if (-not (Test-Path -LiteralPath $aeonquillOfflineTauriCli -PathType Leaf)) {
    throw 'The verified offline Tauri CLI is required when AEONQUILL_WEBVIEW2_OFFLINE_INSTALLER is set.'
  }
  $aeonquillOfflineHash = Get-AeonquillSha256Hex -Path $aeonquillOfflineTauriCli
  if ($aeonquillOfflineHash -ne $aeonquillOfflineTauriCliSha256) {
    throw "The offline Tauri CLI hash does not match the reviewed build: $aeonquillOfflineHash"
  }
  $aeonquillOfflineVersion = ((& $aeonquillOfflineTauriCli --version) -join '').Trim()
  if ($LASTEXITCODE -ne 0 -or $aeonquillOfflineVersion -ne 'tauri-cli 2.11.4') {
    throw "The offline Tauri CLI version is not the reviewed 2.11.4 build: $aeonquillOfflineVersion"
  }
}

if ($Mode -eq 'check') {
  & $aeonquillCargo fmt --manifest-path $aeonquillManifest --check
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $aeonquillCargo check --manifest-path $aeonquillManifest
  exit $LASTEXITCODE
}

Push-Location (Join-Path $aeonquillProjectRoot 'desktop\tauri')
try {
  if ($Mode -eq 'bundle-existing') {
    $aeonquillTauriArguments = @('bundle', '--ci', '--bundles', 'nsis')
  } else {
    $aeonquillTauriArguments = @('build', '--ci')
  }
  if (-not [string]::IsNullOrWhiteSpace($env:AEONQUILL_TAURI_CONFIG)) {
    $aeonquillSigningConfig = (Resolve-Path -LiteralPath $env:AEONQUILL_TAURI_CONFIG).Path
    $aeonquillTauriArguments += @('--config', $aeonquillSigningConfig)
  }
  if ($Mode -eq 'debug') {
    $aeonquillTauriArguments += @('--debug', '--no-bundle')
  } elseif ($Mode -eq 'release') {
    $aeonquillTauriArguments += '--no-bundle'
  } elseif ($Mode -eq 'bundle') {
    $aeonquillTauriArguments += @('--bundles', 'nsis')
  }
  if ($aeonquillUseOfflineTauriCli) {
    & $aeonquillOfflineTauriCli @aeonquillTauriArguments
  } else {
    & (Get-Command node.exe).Source $aeonquillTauriCli @aeonquillTauriArguments
  }
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
