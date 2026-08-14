param(
  [ValidateSet('check', 'debug', 'release', 'bundle')]
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

if (-not (Test-Path -LiteralPath $aeonquillCargo -PathType Leaf)) {
  throw 'Project-local Rust toolchain is missing. Install it under .runtime/toolchains/rust first.'
}
if (-not (Test-Path -LiteralPath $aeonquillTauriCli -PathType Leaf)) {
  throw '@tauri-apps/cli is not installed.'
}

if ($Mode -eq 'check') {
  & $aeonquillCargo fmt --manifest-path $aeonquillManifest --check
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $aeonquillCargo check --manifest-path $aeonquillManifest
  exit $LASTEXITCODE
}

Push-Location (Join-Path $aeonquillProjectRoot 'desktop\tauri')
try {
  $aeonquillTauriArguments = @('build', '--ci')
  if ($Mode -eq 'debug') {
    $aeonquillTauriArguments += @('--debug', '--no-bundle')
  } elseif ($Mode -eq 'release') {
    $aeonquillTauriArguments += '--no-bundle'
  } elseif ($Mode -eq 'bundle') {
    $aeonquillTauriArguments += @('--bundles', 'nsis')
  }
  & (Get-Command node.exe).Source $aeonquillTauriCli @aeonquillTauriArguments
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
