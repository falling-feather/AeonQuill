param(
  [string]$VoiceName = 'Microsoft Huihui Desktop'
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$VoiceDir = Join-Path $ProjectRoot 'assets\voice'
$BgmDir = Join-Path $ProjectRoot 'assets\bgm'
$MasterDir = Join-Path $ProjectRoot 'assets\audio'
New-Item -ItemType Directory -Force -Path $VoiceDir, $BgmDir, $MasterDir | Out-Null

$Ffmpeg = (Get-Command ffmpeg -ErrorAction Stop).Source
$Ffprobe = (Get-Command ffprobe -ErrorAction Stop).Source

$Lines = @(
  @{ Id = 'frame-01'; Text = '灵感，不该散落在工具之间。'; Duration = 4.2 },
  @{ Id = 'frame-02'; Text = '光阴砚，让图像、像素和视频，汇成一条链。'; Duration = 5.0 },
  @{ Id = 'frame-03'; Text = '资源与工作流，跨模式复用，随时恢复。'; Duration = 5.2 },
  @{ Id = 'frame-04'; Text = '导演、编剧、分镜与剪辑智能体协作；每一步，由你决定。'; Duration = 6.2 },
  @{ Id = 'frame-05'; Text = '以光为墨，以时为卷。一念落砚，万象成章。'; Duration = 5.4 }
)

Add-Type -AssemblyName System.Speech
$Synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
$Available = @($Synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
if ($Available -notcontains $VoiceName) {
  throw "Requested voice '$VoiceName' is unavailable. Installed: $($Available -join ', ')"
}
$Synth.SelectVoice($VoiceName)
$Synth.Rate = 0
$Synth.Volume = 100

$FinalLinePaths = @()
$VoiceMetadata = @()
foreach ($Line in $Lines) {
  $RawPath = Join-Path $VoiceDir "$($Line.Id)-raw.wav"
  $FinalPath = Join-Path $VoiceDir "$($Line.Id).wav"
  $Synth.SetOutputToWaveFile($RawPath)
  $Synth.Speak($Line.Text)
  $Synth.SetOutputToNull()

  $RawDuration = [double](& $Ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $RawPath)
  $MaxSpeech = [double]$Line.Duration - 0.32
  $Tempo = if ($RawDuration -gt $MaxSpeech) { $RawDuration / $MaxSpeech } else { 1.0 }
  if ($Tempo -gt 2.0) { throw "Voice line $($Line.Id) requires unsupported tempo $Tempo" }
  $TempoText = $Tempo.ToString('0.000000', [Globalization.CultureInfo]::InvariantCulture)
  $DurationText = ([double]$Line.Duration).ToString('0.000', [Globalization.CultureInfo]::InvariantCulture)
  $Filter = "aresample=48000,highpass=f=75,lowpass=f=10500,dynaudnorm=f=150:g=5,atempo=$TempoText,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo,apad,atrim=duration=$DurationText,afade=t=out:st=$(([double]$Line.Duration - 0.16).ToString('0.000', [Globalization.CultureInfo]::InvariantCulture)):d=0.16"
  & $Ffmpeg -hide_banner -loglevel error -y -i $RawPath -af $Filter -c:a pcm_s16le $FinalPath
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg voice normalization failed for $($Line.Id)" }
  $FinalLinePaths += $FinalPath
  $VoiceMetadata += [ordered]@{
    id = $Line.Id
    text = $Line.Text
    path = "assets/voice/$($Line.Id).wav"
    duration_s = [double]$Line.Duration
    source_duration_s = [Math]::Round($RawDuration, 3)
    tempo = [Math]::Round($Tempo, 4)
  }
}
$Synth.Dispose()

$VoiceoverPath = Join-Path $VoiceDir 'aeonquill-voiceover.wav'
$Inputs = @()
$Labels = @()
for ($Index = 0; $Index -lt $FinalLinePaths.Count; $Index += 1) {
  $Inputs += @('-i', $FinalLinePaths[$Index])
  $Labels += "[${Index}:a]"
}
$ConcatFilter = "$($Labels -join '')concat=n=$($FinalLinePaths.Count):v=0:a=1[out]"
& $Ffmpeg -hide_banner -loglevel error -y @Inputs -filter_complex $ConcatFilter -map '[out]' -c:a pcm_s16le $VoiceoverPath
if ($LASTEXITCODE -ne 0) { throw 'ffmpeg voice concat failed' }

$BgmPath = Join-Path $BgmDir 'aeonquill-ink-time.wav'
& node (Join-Path $PSScriptRoot 'generate-bgm.mjs') $BgmPath 26
if ($LASTEXITCODE -ne 0) { throw 'procedural BGM generation failed' }

$SfxRoot = Join-Path $ProjectRoot 'assets\sfx'
$MasterPath = Join-Path $MasterDir 'aeonquill-ad-master.wav'
$SfxWhoosh = Join-Path $SfxRoot 'whoosh-cinematic.mp3'
$SfxClick = Join-Path $SfxRoot 'click-soft.mp3'
$SfxShort = Join-Path $SfxRoot 'whoosh-short.mp3'
$SfxNotify = Join-Path $SfxRoot 'notification.mp3'
$SfxChime = Join-Path $SfxRoot 'chime.mp3'
$MixFilter = @"
[0:a]volume=1.0[voice];
[1:a]volume=0.42,afade=t=in:st=0:d=1.2,afade=t=out:st=23.8:d=2.2[bed];
[2:a]atrim=0:2.2,volume=0.17[s0];
[3:a]volume=0.23,adelay=4200|4200[s1];
[4:a]volume=0.15,adelay=9200|9200[s2];
[5:a]volume=0.16,adelay=14400|14400[s3];
[6:a]volume=0.20,adelay=20600|20600[s4];
[voice][bed][s0][s1][s2][s3][s4]amix=inputs=7:duration=longest:normalize=0,alimiter=limit=0.92,atrim=duration=26[out]
"@ -replace "`r?`n", ''
& $Ffmpeg -hide_banner -loglevel error -y -i $VoiceoverPath -i $BgmPath -i $SfxWhoosh -i $SfxClick -i $SfxShort -i $SfxNotify -i $SfxChime -filter_complex $MixFilter -map '[out]' -ar 48000 -ac 2 -c:a pcm_s16le $MasterPath
if ($LASTEXITCODE -ne 0) { throw 'ffmpeg audio master failed' }

$Metadata = [ordered]@{
  version = 1
  duration_s = 26
  voice = [ordered]@{
    provider = 'Windows SAPI 5 offline fallback'
    voice = $VoiceName
    master = 'assets/voice/aeonquill-voiceover.wav'
    lines = $VoiceMetadata
  }
  bgm = [ordered]@{
    provider = 'deterministic procedural synthesis'
    path = 'assets/bgm/aeonquill-ink-time.wav'
    bpm = 92
    prompt = 'restrained cinematic Chinese ink and modern technology underscore, no vocals'
  }
  master = [ordered]@{
    path = 'assets/audio/aeonquill-ad-master.wav'
    sample_rate = 48000
    channels = 2
  }
  note = 'HeyGen was not authenticated and Kokoro/MusicGen were unavailable; no dependency was installed on C:. Voice and music were produced offline on D:.'
}
$Metadata | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $ProjectRoot 'audio-production.json') -Encoding utf8NoBOM
Write-Output "generated $MasterPath"
