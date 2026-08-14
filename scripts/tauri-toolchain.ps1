param(
  [ValidateSet('check', 'debug', 'release', 'bundle')]
  [string]$Mode = 'check'
)

$ErrorActionPreference = 'Stop'
$miaohuiProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$miaohuiVsShell = 'C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\Tools\Launch-VsDevShell.ps1'
if (-not (Test-Path -LiteralPath $miaohuiVsShell -PathType Leaf)) {
  throw 'Visual Studio 2022 C++ Build Tools were not found.'
}

& $miaohuiVsShell -Arch amd64 -HostArch amd64 -SkipAutomaticLocation

# Launch-VsDevShell changes terminal encoding on this machine, so resolve the
# Unicode workspace paths only after the MSVC environment has been loaded.
$miaohuiRustRoot = (Resolve-Path (Join-Path $miaohuiProjectRoot '.runtime\toolchains\rust')).Path
$env:RUSTUP_HOME = Join-Path $miaohuiRustRoot 'rustup'
$env:CARGO_HOME = Join-Path $miaohuiRustRoot 'cargo'
$env:PATH = "$(Join-Path $env:CARGO_HOME 'bin');$env:PATH"
$miaohuiCargo = Join-Path $env:CARGO_HOME 'bin\cargo.exe'
$miaohuiManifest = Join-Path $miaohuiProjectRoot 'desktop\tauri\src-tauri\Cargo.toml'
$miaohuiTauriCli = Join-Path $miaohuiProjectRoot 'node_modules\@tauri-apps\cli\tauri.js'

if (-not (Test-Path -LiteralPath $miaohuiCargo -PathType Leaf)) {
  throw 'Project-local Rust toolchain is missing. Install it under .runtime/toolchains/rust first.'
}
if (-not (Test-Path -LiteralPath $miaohuiTauriCli -PathType Leaf)) {
  throw '@tauri-apps/cli is not installed.'
}

if ($Mode -eq 'check') {
  & $miaohuiCargo fmt --manifest-path $miaohuiManifest --check
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $miaohuiCargo check --manifest-path $miaohuiManifest
  exit $LASTEXITCODE
}

Push-Location (Join-Path $miaohuiProjectRoot 'desktop\tauri')
try {
  $miaohuiTauriArguments = @('build', '--ci')
  if ($Mode -eq 'debug') {
    $miaohuiTauriArguments += @('--debug', '--no-bundle')
  } elseif ($Mode -eq 'release') {
    $miaohuiTauriArguments += '--no-bundle'
  } elseif ($Mode -eq 'bundle') {
    $miaohuiTauriArguments += @('--bundles', 'nsis')
  }
  & (Get-Command node.exe).Source $miaohuiTauriCli @miaohuiTauriArguments
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
