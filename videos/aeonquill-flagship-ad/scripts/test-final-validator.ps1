[CmdletBinding()]
param(
  [string]$RuntimeDirectory = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

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

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($RuntimeDirectory)) {
  $RuntimeDirectory = Join-Path $projectRoot ".runtime\validator-smoke"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$caseRoot = Join-Path ([IO.Path]::GetFullPath($RuntimeDirectory)) $stamp
[void](New-Item -ItemType Directory -Force -Path $caseRoot)

$fixturePath = Join-Path $caseRoot "valid-21s-720p.mp4"
$passingReportPath = Join-Path $caseRoot "passing.qa.json"
$failingReportPath = Join-Path $caseRoot "unexpected-failure-report.qa.json"
$ffmpeg = (Get-Command ffmpeg -ErrorAction Stop).Source
$validatorPath = Join-Path $PSScriptRoot "validate-final-video.ps1"
$renderPath = Join-Path $PSScriptRoot "render-final-720p.ps1"
$renderSource = Get-Content -LiteralPath $renderPath -Raw
if ($renderSource -notmatch 'Get-Command npx\.cmd') {
  throw "The approved render path must resolve npx.cmd explicitly under Windows PowerShell strict mode."
}
if ($renderSource -match '-Executable\s+["'']npx["'']') {
  throw "The approved render path must not invoke the npx.ps1 shim from a strict-mode scope."
}
if ($renderSource -notmatch 'loudnorm=I=-14:TP=-1\.5:LRA=11:print_format=json') {
  throw "The approved render path must analyze EBU R128 loudness before delivery encoding."
}
if (
  $renderSource -notmatch 'measured_I=' -or
  $renderSource -notmatch 'measured_LRA=' -or
  $renderSource -notmatch 'measured_TP=' -or
  $renderSource -notmatch 'measured_thresh=' -or
  $renderSource -notmatch 'offset='
) {
  throw "The approved render path must apply measured two-pass loudness normalization."
}
if ($renderSource -notmatch '\[IO\.File\]::ReadAllText') {
  throw "The approved render path must preserve non-ASCII QA paths with explicit UTF-8 reads."
}

Invoke-CheckedCommand -Executable $ffmpeg -Arguments @(
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=21",
  "-f", "lavfi", "-i", "aevalsrc=0.16*sin(2*PI*440*t)|0.16*sin(2*PI*554.37*t):s=48000:d=21",
  "-c:v", "libx264", "-preset", "ultrafast", "-crf", "35",
  "-pix_fmt", "yuv420p", "-r", "30",
  "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
  "-shortest", "-movflags", "+faststart",
  $fixturePath
) -FailureMessage "Unable to create the validator smoke-test fixture"

$passingResult = & $validatorPath -InputPath $fixturePath -ReportPath $passingReportPath
if ($null -eq $passingResult -or -not $passingResult.Ok) {
  throw "The passing validator case did not return a passing result."
}
if (-not (Test-Path -LiteralPath $passingReportPath)) {
  throw "The passing validator case did not write its QA report."
}

$expectedFailureObserved = $false
$expectedFailureMessage = ""
try {
  & $validatorPath `
    -InputPath $fixturePath `
    -ReportPath $failingReportPath `
    -MinimumDurationSeconds 22 | Out-Null
}
catch {
  $expectedFailureObserved = $true
  $expectedFailureMessage = $_.Exception.Message
}

if (-not $expectedFailureObserved) {
  throw "The intentionally failing validator case was incorrectly accepted."
}
if (Test-Path -LiteralPath $failingReportPath) {
  throw "The intentionally failing validator case wrote a misleading QA report."
}

[pscustomobject]@{
  Ok = $true
  RuntimeDirectory = $caseRoot
  PassingReport = $passingReportPath
  PassingDurationSeconds = $passingResult.DurationSeconds
  PassingResolution = $passingResult.Resolution
  PassingCodecs = $passingResult.Codecs
  ExpectedFailureObserved = $expectedFailureObserved
  ExpectedFailureMessage = $expectedFailureMessage
} | Format-List
