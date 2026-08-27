[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,
  [string]$ReportPath = "",
  [double]$MinimumDurationSeconds = 20,
  [double]$MaximumDurationSeconds = 27,
  [int]$ExpectedWidth = 1280,
  [int]$ExpectedHeight = 720,
  [string]$ExpectedFrameRate = "30/1",
  [double]$MaximumBlackSegmentSeconds = 0.5,
  [double]$MaximumFreezeSegmentSeconds = 3.0,
  [double]$MinimumIntegratedLufs = -18,
  [double]$MaximumIntegratedLufs = -11,
  [double]$MaximumTruePeakDb = -1.0
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Convert-ToInvariantDouble {
  param([Parameter(Mandatory = $true)][object]$Value)
  return [double]::Parse(
    [string]$Value,
    [Globalization.CultureInfo]::InvariantCulture
  )
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

function Invoke-CapturedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailureMessage
  )

  $capturedExitCode = $null
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $captured = & $Executable @Arguments 2>&1 | Out-String
    $capturedExitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($null -eq $capturedExitCode -or $capturedExitCode -ne 0) {
    throw "$FailureMessage (exit=$capturedExitCode)"
  }
  return $captured
}

$resolvedInput = (Resolve-Path -LiteralPath $InputPath -ErrorAction Stop).Path
$inputItem = Get-Item -LiteralPath $resolvedInput
if ($inputItem.Length -le 0) {
  throw "Input video is empty."
}

if ([string]::IsNullOrWhiteSpace($ReportPath)) {
  $reportName = "{0}.qa.json" -f [IO.Path]::GetFileNameWithoutExtension($resolvedInput)
  $ReportPath = Join-Path $inputItem.DirectoryName $reportName
}
$resolvedReport = [IO.Path]::GetFullPath($ReportPath)

$ffmpegCommand = Get-Command ffmpeg -ErrorAction Stop
$ffprobeCommand = Get-Command ffprobe -ErrorAction Stop
$ffmpeg = $ffmpegCommand.Source
$ffprobe = $ffprobeCommand.Source

$probeText = Invoke-CapturedCommand -Executable $ffprobe -Arguments @(
  "-v", "error",
  "-show_entries", "format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
  "-of", "json",
  $resolvedInput
) -FailureMessage "ffprobe failed to inspect the delivery file"

$probe = $probeText | ConvertFrom-Json
$videoStreams = @($probe.streams | Where-Object codec_type -eq "video")
$audioStreams = @($probe.streams | Where-Object codec_type -eq "audio")
if ($videoStreams.Count -ne 1) {
  throw "Delivery must contain exactly one video stream; found $($videoStreams.Count)."
}
if ($audioStreams.Count -ne 1) {
  throw "Delivery must contain exactly one audio stream; found $($audioStreams.Count)."
}

$videoStream = $videoStreams[0]
$audioStream = $audioStreams[0]
$durationSeconds = Convert-ToInvariantDouble $probe.format.duration

if ($videoStream.codec_name -ne "h264") {
  throw "Delivery video codec is not H.264: $($videoStream.codec_name)"
}
if ([int]$videoStream.width -ne $ExpectedWidth -or [int]$videoStream.height -ne $ExpectedHeight) {
  throw "Delivery resolution is not ${ExpectedWidth}x${ExpectedHeight}: $($videoStream.width)x$($videoStream.height)"
}
if ($videoStream.r_frame_rate -ne $ExpectedFrameRate) {
  throw "Delivery frame rate is not ${ExpectedFrameRate}: $($videoStream.r_frame_rate)"
}
if ($durationSeconds -lt $MinimumDurationSeconds -or $durationSeconds -gt $MaximumDurationSeconds) {
  throw "Delivery duration is outside the accepted range: $durationSeconds seconds"
}
if ($audioStream.codec_name -ne "aac") {
  throw "Delivery audio codec is not AAC: $($audioStream.codec_name)"
}
if ([int]$audioStream.sample_rate -ne 48000) {
  throw "Delivery audio sample rate is not 48000 Hz: $($audioStream.sample_rate)"
}
if ([int]$audioStream.channels -ne 2) {
  throw "Delivery audio is not stereo: $($audioStream.channels) channel(s)"
}

$seekSeconds = $durationSeconds / 2
$seekValue = $seekSeconds.ToString("0.###", [Globalization.CultureInfo]::InvariantCulture)
Invoke-CheckedCommand -Executable $ffmpeg -Arguments @(
  "-v", "error",
  "-ss", $seekValue,
  "-i", $resolvedInput,
  "-frames:v", "1",
  "-f", "null", "-"
) -FailureMessage "Delivery seek/decode test failed"

$blackLog = Invoke-CapturedCommand -Executable $ffmpeg -Arguments @(
  "-hide_banner", "-nostats",
  "-i", $resolvedInput,
  "-vf", "blackdetect=d=0.15:pix_th=0.10",
  "-an", "-f", "null", "-"
) -FailureMessage "Black-frame analysis failed"

$blackSegments = @(
  [regex]::Matches(
    $blackLog,
    "black_start:(?<start>[0-9.]+)\s+black_end:(?<end>[0-9.]+)\s+black_duration:(?<duration>[0-9.]+)"
  ) | ForEach-Object {
    [pscustomobject][ordered]@{
      start = Convert-ToInvariantDouble ($_.Groups["start"].Value)
      end = Convert-ToInvariantDouble ($_.Groups["end"].Value)
      duration = Convert-ToInvariantDouble ($_.Groups["duration"].Value)
    }
  }
)
$blockingBlackSegments = @(
  $blackSegments | Where-Object duration -gt $MaximumBlackSegmentSeconds
)
if ($blockingBlackSegments.Count -gt 0) {
  throw "A black segment exceeded $MaximumBlackSegmentSeconds seconds."
}

$freezeLog = Invoke-CapturedCommand -Executable $ffmpeg -Arguments @(
  "-hide_banner", "-nostats",
  "-i", $resolvedInput,
  "-vf", "freezedetect=n=-55dB:d=2.0",
  "-an", "-f", "null", "-"
) -FailureMessage "Freeze analysis failed"

$freezeSegments = New-Object System.Collections.ArrayList
$currentFreeze = $null
$freezeMatches = [regex]::Matches(
  $freezeLog,
  "freeze_(?<kind>start|end|duration):\s*(?<value>[0-9.]+)"
)
foreach ($freezeMatch in $freezeMatches) {
  $kind = $freezeMatch.Groups["kind"].Value
  $value = Convert-ToInvariantDouble ($freezeMatch.Groups["value"].Value)
  if ($kind -eq "start") {
    $currentFreeze = [ordered]@{ start = $value; end = $null; duration = $null }
    continue
  }
  if ($null -eq $currentFreeze) {
    continue
  }
  if ($kind -eq "duration") {
    $currentFreeze.duration = $value
    continue
  }
  if ($kind -eq "end") {
    $currentFreeze.end = $value
    if ($null -eq $currentFreeze.duration) {
      $currentFreeze.duration = $currentFreeze.end - $currentFreeze.start
    }
    [void]$freezeSegments.Add([pscustomobject]$currentFreeze)
    $currentFreeze = $null
  }
}
if ($null -ne $currentFreeze) {
  if ($null -eq $currentFreeze.duration) {
    $currentFreeze.duration = $durationSeconds - $currentFreeze.start
  }
  if ($null -eq $currentFreeze.end) {
    $currentFreeze.end = $currentFreeze.start + $currentFreeze.duration
  }
  [void]$freezeSegments.Add([pscustomobject]$currentFreeze)
}

$blockingFreezeSegments = @(
  $freezeSegments | Where-Object duration -gt $MaximumFreezeSegmentSeconds
)
if ($blockingFreezeSegments.Count -gt 0) {
  throw "A freeze segment exceeded $MaximumFreezeSegmentSeconds seconds."
}

$loudnessLog = Invoke-CapturedCommand -Executable $ffmpeg -Arguments @(
  "-hide_banner", "-nostats",
  "-i", $resolvedInput,
  "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json",
  "-f", "null", "-"
) -FailureMessage "Loudness analysis failed"
$loudnessMatch = [regex]::Match($loudnessLog, '(?s)\{\s*"input_i".*?\}')
if (-not $loudnessMatch.Success) {
  throw "Unable to parse loudness measurements from FFmpeg output."
}
$loudness = $loudnessMatch.Value | ConvertFrom-Json
$integratedLufs = Convert-ToInvariantDouble $loudness.input_i
$truePeakDb = Convert-ToInvariantDouble $loudness.input_tp
if ($integratedLufs -lt $MinimumIntegratedLufs -or $integratedLufs -gt $MaximumIntegratedLufs) {
  throw "Integrated loudness is outside the release range: $integratedLufs LUFS"
}
if ($truePeakDb -gt $MaximumTruePeakDb) {
  throw "True peak exceeds the release ceiling: $truePeakDb dBTP"
}

$inputHash = Get-Sha256Hex -Path $resolvedInput
$report = [ordered]@{
  ok = $true
  generatedAt = (Get-Date).ToString("o")
  thresholds = [ordered]@{
    minimumDurationSeconds = $MinimumDurationSeconds
    maximumDurationSeconds = $MaximumDurationSeconds
    expectedWidth = $ExpectedWidth
    expectedHeight = $ExpectedHeight
    expectedFrameRate = $ExpectedFrameRate
    maximumBlackSegmentSeconds = $MaximumBlackSegmentSeconds
    maximumFreezeSegmentSeconds = $MaximumFreezeSegmentSeconds
    minimumIntegratedLufs = $MinimumIntegratedLufs
    maximumIntegratedLufs = $MaximumIntegratedLufs
    maximumTruePeakDb = $MaximumTruePeakDb
  }
  delivery = [ordered]@{
    path = $resolvedInput
    bytes = $inputItem.Length
    sha256 = $inputHash
    durationSeconds = $durationSeconds
    videoCodec = $videoStream.codec_name
    width = [int]$videoStream.width
    height = [int]$videoStream.height
    frameRate = $videoStream.r_frame_rate
    audioCodec = $audioStream.codec_name
    audioSampleRate = [int]$audioStream.sample_rate
    audioChannels = [int]$audioStream.channels
  }
  qa = [ordered]@{
    seekAtSeconds = $seekSeconds
    blackSegments = $blackSegments
    freezeSegments = @($freezeSegments)
    loudness = $loudness
  }
}

$reportDirectory = Split-Path -Parent $resolvedReport
if (-not [string]::IsNullOrWhiteSpace($reportDirectory)) {
  [void](New-Item -ItemType Directory -Force -Path $reportDirectory)
}
$reportJson = $report | ConvertTo-Json -Depth 12
[IO.File]::WriteAllText($resolvedReport, $reportJson, [Text.UTF8Encoding]::new($false))

[pscustomobject]@{
  Ok = $true
  Delivery = $resolvedInput
  DurationSeconds = $durationSeconds
  Resolution = "$($videoStream.width)x$($videoStream.height)"
  Codecs = "$($videoStream.codec_name)/$($audioStream.codec_name)"
  IntegratedLufs = $integratedLufs
  TruePeakDb = $truePeakDb
  Sha256 = $inputHash
  QaReport = $resolvedReport
}
