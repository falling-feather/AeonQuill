[CmdletBinding()]
param(
  [switch]$Approved,
  [string]$OutputDirectory = "",
  [ValidateRange(1, 8)]
  [int]$Workers = 2
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $Approved) {
  throw "Review approval is required. Run with -Approved only after explicit user approval."
}

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $projectRoot "renders"
}

$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$runtimeRoot = Join-Path $projectRoot ".runtime"
$tempRoot = Join-Path $runtimeRoot "temp"
$npmCacheRoot = Join-Path $runtimeRoot "npm-cache"
$qaRoot = Join-Path $outputRoot "qa"
foreach ($directory in @($outputRoot, $runtimeRoot, $tempRoot, $npmCacheRoot, $qaRoot)) {
  [void](New-Item -ItemType Directory -Force -Path $directory)
}

$env:TEMP = $tempRoot
$env:TMP = $tempRoot
$env:npm_config_cache = $npmCacheRoot
$env:HYPERFRAMES_NO_TELEMETRY = "1"

$ffmpegCommand = Get-Command ffmpeg -ErrorAction Stop
$ffmpeg = $ffmpegCommand.Source

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$masterPath = Join-Path $outputRoot "AEONQUILL-flagship-ad-$stamp-master-1080p.mp4"
$deliveryPath = Join-Path $outputRoot "AEONQUILL-flagship-ad-$stamp-720p.mp4"
$reportPath = Join-Path $qaRoot "AEONQUILL-flagship-ad-$stamp-qa.json"

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailureMessage
  )

  $capturedExitCode = $null
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $Executable @Arguments
    $capturedExitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($null -eq $capturedExitCode -or $capturedExitCode -ne 0) {
    throw "$FailureMessage (exit=$capturedExitCode)"
  }
}

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)

  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $algorithm.ComputeHash($stream)
  }
  finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
  return ([BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
}

Push-Location $projectRoot
try {
  Invoke-CheckedCommand -Executable "npx" -Arguments @(
    "--yes", "hyperframes@0.8.16", "check",
    "--at-transitions", "--samples", "15"
  ) -FailureMessage "HyperFrames final check failed"

  Invoke-CheckedCommand -Executable "npx" -Arguments @(
    "--yes", "hyperframes@0.8.16", "render",
    "--output", $masterPath,
    "--fps", "30",
    "--quality", "high",
    "--crf", "12",
    "--workers", [string]$Workers,
    "--browser-timeout", "120",
    "--strict",
    "--sdr"
  ) -FailureMessage "HyperFrames 1080p master render failed"
}
finally {
  Pop-Location
}

Invoke-CheckedCommand -Executable $ffmpeg -Arguments @(
  "-hide_banner", "-y",
  "-i", $masterPath,
  "-vf", "scale=1280:720:flags=lanczos,format=yuv420p",
  "-r", "30",
  "-c:v", "libx264",
  "-preset", "slow",
  "-crf", "16",
  "-profile:v", "high",
  "-level:v", "4.1",
  "-c:a", "aac",
  "-b:a", "192k",
  "-ar", "48000",
  "-ac", "2",
  "-movflags", "+faststart",
  $deliveryPath
) -FailureMessage "720p delivery encode failed"

$validatorPath = Join-Path $PSScriptRoot "validate-final-video.ps1"
$qaResult = & $validatorPath -InputPath $deliveryPath -ReportPath $reportPath
if ($null -eq $qaResult -or -not $qaResult.Ok) {
  throw "Final video validation did not return a passing result."
}

$masterItem = Get-Item -LiteralPath $masterPath
$masterHash = Get-Sha256Hex -Path $masterPath
$report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
$report | Add-Member -NotePropertyName render -NotePropertyValue ([ordered]@{
    hyperframesVersion = "0.8.16"
    fps = 30
    quality = "high"
    masterCrf = 12
    deliveryCrf = 16
    deliveryPreset = "slow"
    workers = $Workers
  })
$report | Add-Member -NotePropertyName master -NotePropertyValue ([ordered]@{
    path = $masterPath
    bytes = $masterItem.Length
    sha256 = $masterHash
  })
$reportJson = $report | ConvertTo-Json -Depth 12
[IO.File]::WriteAllText($reportPath, $reportJson, [Text.UTF8Encoding]::new($false))

[pscustomobject]@{
  Master = $masterPath
  Delivery = $deliveryPath
  DurationSeconds = $qaResult.DurationSeconds
  Resolution = $qaResult.Resolution
  Codecs = $qaResult.Codecs
  IntegratedLufs = $qaResult.IntegratedLufs
  TruePeakDb = $qaResult.TruePeakDb
  Sha256 = $qaResult.Sha256
  QaReport = $reportPath
} | Format-List
