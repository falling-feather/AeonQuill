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
$ffprobeCommand = Get-Command ffprobe -ErrorAction Stop
$ffmpeg = $ffmpegCommand.Source
$ffprobe = $ffprobeCommand.Source

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

  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage (exit=$LASTEXITCODE)"
  }
}

function Convert-ToInvariantDouble {
  param([Parameter(Mandatory = $true)][object]$Value)
  return [double]::Parse(
    [string]$Value,
    [Globalization.CultureInfo]::InvariantCulture
  )
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

$probeText = & $ffprobe -v error -show_entries `
  "format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels" `
  -of json $deliveryPath 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  throw "ffprobe failed to inspect the delivery file (exit=$LASTEXITCODE)"
}

$probe = $probeText | ConvertFrom-Json
$videoStream = @($probe.streams | Where-Object codec_type -eq "video")[0]
$audioStream = @($probe.streams | Where-Object codec_type -eq "audio")[0]
$durationSeconds = Convert-ToInvariantDouble $probe.format.duration

if ($videoStream.codec_name -ne "h264") {
  throw "Delivery video codec is not H.264: $($videoStream.codec_name)"
}
if ([int]$videoStream.width -ne 1280 -or [int]$videoStream.height -ne 720) {
  throw "Delivery resolution is not 1280x720: $($videoStream.width)x$($videoStream.height)"
}
if ($durationSeconds -lt 20 -or $durationSeconds -gt 27) {
  throw "Delivery duration is outside the accepted range: $durationSeconds seconds"
}
if ($audioStream.codec_name -ne "aac") {
  throw "Delivery audio codec is not AAC: $($audioStream.codec_name)"
}

Invoke-CheckedCommand -Executable $ffmpeg -Arguments @(
  "-v", "error",
  "-ss", "00:00:13.000",
  "-i", $deliveryPath,
  "-frames:v", "1",
  "-f", "null", "-"
) -FailureMessage "Delivery seek/decode test failed"

$blackLog = & $ffmpeg -hide_banner -nostats -i $deliveryPath `
  -vf "blackdetect=d=0.15:pix_th=0.10" -an -f null - 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  throw "Black-frame analysis failed (exit=$LASTEXITCODE)"
}

$blackSegments = @(
  [regex]::Matches(
    $blackLog,
    "black_start:(?<start>[0-9.]+)\s+black_end:(?<end>[0-9.]+)\s+black_duration:(?<duration>[0-9.]+)"
  ) | ForEach-Object {
    [ordered]@{
      start = Convert-ToInvariantDouble $_.Groups["start"].Value
      end = Convert-ToInvariantDouble $_.Groups["end"].Value
      duration = Convert-ToInvariantDouble $_.Groups["duration"].Value
    }
  }
)

$interiorBlackSegments = @(
  $blackSegments | Where-Object {
    $_.duration -gt 0.5 -and $_.start -gt 0.25 -and $_.end -lt ($durationSeconds - 0.25)
  }
)
if ($interiorBlackSegments.Count -gt 0) {
  throw "An interior black segment longer than 0.5 seconds was detected."
}

$freezeLog = & $ffmpeg -hide_banner -nostats -i $deliveryPath `
  -vf "freezedetect=n=-55dB:d=2.0" -an -f null - 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  throw "Freeze analysis failed (exit=$LASTEXITCODE)"
}
$freezeEvents = @(
  [regex]::Matches($freezeLog, "freeze_(?:start|end|duration):\s*[0-9.]+") |
    ForEach-Object Value
)

$loudnessLog = & $ffmpeg -hide_banner -nostats -i $deliveryPath `
  -af "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json" -f null - 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  throw "Loudness analysis failed (exit=$LASTEXITCODE)"
}
$loudnessMatch = [regex]::Match($loudnessLog, '(?s)\{\s*"input_i".*?\}')
if (-not $loudnessMatch.Success) {
  throw "Unable to parse loudness measurements from FFmpeg output."
}
$loudness = $loudnessMatch.Value | ConvertFrom-Json
$integratedLufs = Convert-ToInvariantDouble $loudness.input_i
if ($integratedLufs -lt -18 -or $integratedLufs -gt -11) {
  throw "Integrated loudness is outside the release range: $integratedLufs LUFS"
}

$deliveryItem = Get-Item -LiteralPath $deliveryPath
$masterItem = Get-Item -LiteralPath $masterPath
$deliveryHash = (Get-FileHash -LiteralPath $deliveryPath -Algorithm SHA256).Hash.ToLowerInvariant()
$masterHash = (Get-FileHash -LiteralPath $masterPath -Algorithm SHA256).Hash.ToLowerInvariant()

$report = [ordered]@{
  ok = $true
  generatedAt = (Get-Date).ToString("o")
  render = [ordered]@{
    hyperframesVersion = "0.8.16"
    fps = 30
    quality = "high"
    masterCrf = 12
    deliveryCrf = 16
    deliveryPreset = "slow"
    workers = $Workers
  }
  master = [ordered]@{
    path = $masterPath
    bytes = $masterItem.Length
    sha256 = $masterHash
  }
  delivery = [ordered]@{
    path = $deliveryPath
    bytes = $deliveryItem.Length
    sha256 = $deliveryHash
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
    seekAt13Seconds = "pass"
    interiorBlackSegments = $interiorBlackSegments
    allBlackSegments = $blackSegments
    freezeEvents = $freezeEvents
    loudness = $loudness
  }
}

$reportJson = $report | ConvertTo-Json -Depth 12
[IO.File]::WriteAllText($reportPath, $reportJson, [Text.UTF8Encoding]::new($false))

[pscustomobject]@{
  Delivery = $deliveryPath
  DurationSeconds = $durationSeconds
  Resolution = "$($videoStream.width)x$($videoStream.height)"
  Codecs = "$($videoStream.codec_name)/$($audioStream.codec_name)"
  IntegratedLufs = $integratedLufs
  Sha256 = $deliveryHash
  QaReport = $reportPath
} | Format-List
