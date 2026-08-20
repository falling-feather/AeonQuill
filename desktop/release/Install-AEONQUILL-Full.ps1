[CmdletBinding()]
param(
  [switch]$AcceptMiniMaxH3License,
  [switch]$UsePayloadInPlace,
  [switch]$NoLaunch,
  [switch]$RepairRuntime,
  [string]$InstallBase,
  [switch]$MigrateLegacyData,
  [switch]$RemoveLegacyAfterMigration,
  [switch]$ReplaceExistingApplication
)

$ErrorActionPreference = 'Stop'
$packageId = 'aeonquill-comfyui-h3-cu129-win-x64-v1'
$productVersion = '0.4.2'
$payloadRoot = Join-Path $PSScriptRoot "runtime\$packageId"
$runtimeManifestPath = Join-Path $payloadRoot 'runtime-manifest.json'
$releaseManifestPath = Join-Path $PSScriptRoot 'offline-release-manifest.json'
$releaseChecksumsPath = Join-Path $PSScriptRoot 'SHA256SUMS-offline.txt'

function Assert-ChildPath {
  param([string]$Parent, [string]$Child)
  $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  $childPath = [IO.Path]::GetFullPath($Child)
  if (-not $childPath.StartsWith($parentPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "路径越界：$Child"
  }
}

function Resolve-SafeDirectory {
  param([string]$Path, [string]$Label)
  if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
    throw "$Label 必须是绝对目录。"
  }
  $resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $driveRoot = [IO.Path]::GetPathRoot($resolved).TrimEnd('\')
  if ($resolved -eq $driveRoot) {
    throw "$Label 不能是磁盘根目录。"
  }
  return $resolved
}

function Invoke-Robocopy {
  param([string]$Source, [string]$Destination, [switch]$Move)
  $arguments = @(
    "`"$Source`"",
    "`"$Destination`"",
    '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:2', '/W:1', '/XJ', '/NFL', '/NDL', '/NP'
  )
  if ($Move) { $arguments += '/MOVE' }
  $result = Start-Process -FilePath 'robocopy.exe' -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
  if ($result.ExitCode -gt 7) {
    throw "文件迁移失败，Robocopy 退出码 $($result.ExitCode)。"
  }
}

function Test-CriticalFiles {
  param([string]$Root, [object]$Manifest)
  foreach ($entry in $Manifest.criticalFiles) {
    $relativePath = [string]$entry.path
    if ([IO.Path]::IsPathRooted($relativePath) -or $relativePath.Contains('..')) {
      throw "运行时清单包含不安全路径：$relativePath"
    }
    $pathname = Join-Path $Root ($relativePath.Replace('/', '\'))
    Assert-ChildPath -Parent $Root -Child $pathname
    $file = Get-Item -LiteralPath $pathname -ErrorAction Stop
    if ($file.Length -ne [int64]$entry.bytes) {
      throw "运行时文件大小不匹配：$relativePath"
    }
    $hash = (Get-FileHash -LiteralPath $pathname -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne [string]$entry.sha256) {
      throw "运行时文件校验失败：$relativePath"
    }
  }
}

function Get-BoundArtifact {
  param([object]$ReleaseManifest, [string]$RelativePath)
  $matches = @($ReleaseManifest.artifacts | Where-Object { [string]$_.path -eq $RelativePath })
  if ($matches.Count -ne 1) {
    throw "离线发布清单未唯一绑定文件：$RelativePath"
  }
  return $matches[0]
}

function Test-BoundArtifact {
  param([string]$Root, [object]$Artifact)
  $relativePath = [string]$Artifact.path
  if ([IO.Path]::IsPathRooted($relativePath) -or $relativePath.Contains('..')) {
    throw "离线发布清单包含不安全路径：$relativePath"
  }
  $pathname = Join-Path $Root ($relativePath.Replace('/', '\'))
  Assert-ChildPath -Parent $Root -Child $pathname
  $file = Get-Item -LiteralPath $pathname -ErrorAction Stop
  if ($file.Length -ne [int64]$Artifact.bytes) {
    throw "发布文件大小不匹配：$relativePath"
  }
  $hash = (Get-FileHash -LiteralPath $pathname -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne ([string]$Artifact.sha256).ToLowerInvariant()) {
    throw "发布文件校验失败：$relativePath"
  }
}

if (-not (Test-Path -LiteralPath $releaseManifestPath -PathType Leaf)) {
  throw '未找到 offline-release-manifest.json，请保留完整离线包目录结构。'
}
if (-not (Test-Path -LiteralPath $releaseChecksumsPath -PathType Leaf)) {
  throw '未找到 SHA256SUMS-offline.txt，请保留完整离线包目录结构。'
}
$releaseManifest = Get-Content -LiteralPath $releaseManifestPath -Raw | ConvertFrom-Json
if (
  $releaseManifest.schemaVersion -ne 1 -or
  $releaseManifest.product.name -ne 'AEONQUILL' -or
  $releaseManifest.product.version -ne $productVersion -or
  $releaseManifest.target.platform -ne 'windows' -or
  $releaseManifest.target.architecture -ne 'x64' -or
  $releaseManifest.runtime.packageId -ne $packageId -or
  $releaseManifest.install.entrypoint -ne 'Install-AEONQUILL-Full.cmd'
) {
  throw '离线发布清单的产品、版本、平台或运行时标识无效。'
}
if ([string]$releaseManifest.distributionStatus -ne 'unsigned-local-stage-only') {
  throw '离线发布状态与当前阶段包契约不一致。'
}

$aggregateLines = New-Object Collections.Generic.List[string]
foreach ($artifact in $releaseManifest.artifacts) {
  Test-BoundArtifact -Root $PSScriptRoot -Artifact $artifact
  $aggregateLines.Add("$(([string]$artifact.sha256).ToLowerInvariant())  $([string]$artifact.path)")
}
$aggregate = (($aggregateLines -join "`n") + "`n")
$aggregateBytes = [Text.Encoding]::UTF8.GetBytes($aggregate)
$aggregateHasher = [Security.Cryptography.SHA256]::Create()
try {
  $aggregateHash = ([BitConverter]::ToString($aggregateHasher.ComputeHash($aggregateBytes))).Replace('-', '').ToLowerInvariant()
} finally {
  $aggregateHasher.Dispose()
}
if ($aggregateHash -ne ([string]$releaseManifest.aggregateSha256).ToLowerInvariant()) {
  throw '离线发布清单聚合校验失败。'
}
$recordedChecksums = (Get-Content -LiteralPath $releaseChecksumsPath -Raw).Replace("`r`n", "`n")
if ($recordedChecksums -ne $aggregate) {
  throw 'SHA256SUMS-offline.txt 与离线发布清单不一致。'
}

if (-not (Test-Path -LiteralPath $runtimeManifestPath -PathType Leaf)) {
  throw '未找到离线运行时载荷，请保留安装脚本与 runtime 目录的相对位置。'
}
$runtimeManifest = Get-Content -LiteralPath $runtimeManifestPath -Raw | ConvertFrom-Json
if ($runtimeManifest.schemaVersion -ne 1 -or $runtimeManifest.packageId -ne $packageId -or $runtimeManifest.productVersion -ne $productVersion) {
  throw '离线运行时清单版本或包标识无效。'
}

if (-not $AcceptMiniMaxH3License) {
  Write-Host ''
  Write-Host 'AEONQUILL 完整阶段包包含 MiniMax H3 模型。' -ForegroundColor Cyan
  Write-Host '其许可排除欧盟、英国、韩国和美国，并要求遵守可接受使用政策。'
  Write-Host '本包仅供当前适用地区内的阶段测试；正式商业发布仍需单独法律与安全审查。'
  Write-Host '完整协议：runtime\...\licenses\MiniMax-H3-Community-License.txt'
  $answer = Read-Host '若你确认位于适用地区并接受协议，请输入 ACCEPT'
  if ($answer -cne 'ACCEPT') {
    throw '用户未接受 MiniMax H3 许可，安装已取消。'
  }
}

Write-Host '正在校验离线运行时关键文件（约 40.6 GiB 模型，可能需要数分钟）…'
Test-CriticalFiles -Root $payloadRoot -Manifest $runtimeManifest

$bundleDriveRoot = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($PSScriptRoot))
if ([string]::IsNullOrWhiteSpace($InstallBase)) {
  $InstallBase = Join-Path $bundleDriveRoot 'AEONQUILL'
}
$installationRoot = Resolve-SafeDirectory -Path $InstallBase -Label 'AEONQUILL 安装根目录'
$applicationDirectory = Join-Path $installationRoot 'App'
$appDataRoot = Join-Path $installationRoot 'UserData'
Assert-ChildPath -Parent $installationRoot -Child $applicationDirectory
Assert-ChildPath -Parent $installationRoot -Child $appDataRoot

$runningApplication = @(Get-Process -Name 'aeonquill-desktop', 'aeonquill-bridge' -ErrorAction SilentlyContinue)
if ($runningApplication.Count -gt 0) {
  throw 'AEONQUILL 仍在运行。请先退出应用，再重新执行安装。'
}

$uninstallRegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AEONQUILL'
$existingInstallation = Get-ItemProperty -LiteralPath $uninstallRegistryPath -ErrorAction SilentlyContinue
if ($existingInstallation) {
  $existingDirectory = [IO.Path]::GetFullPath(([string]$existingInstallation.InstallLocation).Trim('"')).TrimEnd('\')
  if ($existingDirectory -ne [IO.Path]::GetFullPath($applicationDirectory).TrimEnd('\')) {
    if (-not $ReplaceExistingApplication) {
      throw "检测到其他位置的 AEONQUILL：$existingDirectory。请使用 -ReplaceExistingApplication 完成受控替换。"
    }
    $existingUninstaller = Join-Path $existingDirectory 'uninstall.exe'
    Assert-ChildPath -Parent $existingDirectory -Child $existingUninstaller
    if (-not (Test-Path -LiteralPath $existingUninstaller -PathType Leaf)) {
      throw '旧版 AEONQUILL 卸载器缺失，拒绝覆盖注册信息。'
    }
    Write-Host "正在卸载旧位置的 AEONQUILL：$existingDirectory"
    $uninstall = Start-Process -FilePath $existingUninstaller -ArgumentList '/S' -Wait -PassThru
    if ($uninstall.ExitCode -ne 0) {
      throw "旧版 AEONQUILL 卸载器退出码为 $($uninstall.ExitCode)。"
    }
  }
}

$legacyDataRoot = Join-Path $env:LOCALAPPDATA 'com.miaohui.desktop'
if ($MigrateLegacyData -and (Test-Path -LiteralPath $legacyDataRoot -PathType Container)) {
  if ([IO.Path]::GetFullPath($legacyDataRoot) -eq [IO.Path]::GetFullPath($appDataRoot)) {
    throw '旧数据目录与目标目录相同，拒绝迁移。'
  }
  New-Item -ItemType Directory -Force -Path $appDataRoot | Out-Null
  Write-Host "正在把旧 AEONQUILL 用户数据迁移到 $appDataRoot …"
  Invoke-Robocopy -Source $legacyDataRoot -Destination $appDataRoot -Move:$RemoveLegacyAfterMigration
  if ($RemoveLegacyAfterMigration -and (Test-Path -LiteralPath $legacyDataRoot -PathType Container)) {
    $remaining = @(Get-ChildItem -LiteralPath $legacyDataRoot -Force -ErrorAction SilentlyContinue)
    if ($remaining.Count -eq 0) {
      Remove-Item -LiteralPath $legacyDataRoot -Force
    } else {
      Write-Warning '旧数据根目录仍包含未迁移项目，已保留该目录。'
    }
  }
}

$runtimePackages = Join-Path $appDataRoot 'runtime\packages'
$runtimeDestination = Join-Path $runtimePackages $packageId
$selectedRuntime = $payloadRoot

if (-not $UsePayloadInPlace) {
  New-Item -ItemType Directory -Force -Path $runtimePackages | Out-Null
  Assert-ChildPath -Parent $runtimePackages -Child $runtimeDestination
  if (Test-Path -LiteralPath $runtimeDestination) {
    if (-not $RepairRuntime) {
      Write-Host '检测到同版本运行时，先校验并复用。使用 -RepairRuntime 可显式重装。'
      Test-CriticalFiles -Root $runtimeDestination -Manifest $runtimeManifest
    } else {
      $resolvedPackages = [IO.Path]::GetFullPath($runtimePackages)
      $resolvedDestination = [IO.Path]::GetFullPath($runtimeDestination)
      if ($resolvedDestination -eq $resolvedPackages -or -not $resolvedDestination.StartsWith($resolvedPackages + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw '拒绝删除未验证的运行时目录。'
      }
      Remove-Item -LiteralPath $runtimeDestination -Recurse -Force
    }
  }
  if (-not (Test-Path -LiteralPath $runtimeDestination)) {
    $drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($runtimeDestination).Substring(0, 1))
    $required = [int64]$runtimeManifest.inventory.bytes + 5GB
    if ($drive.Free -lt $required) {
      throw "目标磁盘空间不足：至少需要 $([Math]::Ceiling($required / 1GB)) GiB。"
    }
    Write-Host '正在复制完整离线运行时；请勿关闭窗口…'
    Invoke-Robocopy -Source $payloadRoot -Destination $runtimeDestination
    Test-CriticalFiles -Root $runtimeDestination -Manifest $runtimeManifest
  }
  $selectedRuntime = $runtimeDestination
}

$configDirectory = Join-Path $appDataRoot 'config'
$configPath = Join-Path $configDirectory 'local.json'
New-Item -ItemType Directory -Force -Path $configDirectory | Out-Null
if (Test-Path -LiteralPath $configPath) {
  Copy-Item -LiteralPath $configPath -Destination "$configPath.pre-v041.bak" -Force
}
$configuration = [ordered]@{
  comfyUrl = 'http://127.0.0.1:8188'
  comfyRoot = Join-Path $selectedRuntime 'ComfyUI'
  pythonPath = Join-Path $selectedRuntime 'python\python.exe'
  comfyLaunchPolicy = 'idle'
  comfyIdleSeconds = 300
  bridgePort = 8787
  allowedOrigins = @()
  imageTools = [ordered]@{
    ffmpegPath = Join-Path $selectedRuntime 'tools\ffmpeg\bin\ffmpeg.exe'
    ffprobePath = Join-Path $selectedRuntime 'tools\ffmpeg\bin\ffprobe.exe'
    rembgPath = ''
    rembgModelsPath = Join-Path $selectedRuntime 'models\rembg'
    realEsrganPath = Join-Path $selectedRuntime 'tools\realesrgan-ncnn-vulkan\realesrgan-ncnn-vulkan.exe'
    realEsrganModelsPath = Join-Path $selectedRuntime 'tools\realesrgan-ncnn-vulkan\models'
  }
  comfyArgs = @(
    'main.py', '--listen', '127.0.0.1', '--port', '8188', '--fast-disk', '--lowvram',
    '--reserve-vram', '1.5', '--disable-pinned-memory', '--cache-none', '--preview-method', 'none'
  )
}
$temporaryConfig = "$configPath.installing"
$configJson = $configuration | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText($temporaryConfig, $configJson + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
Move-Item -LiteralPath $temporaryConfig -Destination $configPath -Force

$installerRelativePath = [string]$releaseManifest.app.installer
$installerArtifact = Get-BoundArtifact -ReleaseManifest $releaseManifest -RelativePath $installerRelativePath
$installerPath = Join-Path $PSScriptRoot $installerRelativePath
Test-BoundArtifact -Root $PSScriptRoot -Artifact $installerArtifact
Write-Host '正在安装 AEONQUILL 应用本体…'
$install = Start-Process -FilePath $installerPath -ArgumentList @('/S', "/D=$applicationDirectory") -Wait -PassThru
if ($install.ExitCode -ne 0) {
  throw "AEONQUILL 安装器退出码为 $($install.ExitCode)。"
}

$appExecutable = Join-Path $applicationDirectory 'aeonquill-desktop.exe'
if (-not (Test-Path -LiteralPath $appExecutable -PathType Leaf)) {
  throw '应用安装完成后未找到 aeonquill-desktop.exe。'
}
$layoutPath = Join-Path $applicationDirectory 'aeonquill-layout.json'
$layout = [ordered]@{
  schemaVersion = 1
  layout = 'sibling-user-data'
  dataDirectoryName = 'UserData'
}
$layoutTemporary = "$layoutPath.installing"
$layoutJson = $layout | ConvertTo-Json -Depth 3
[IO.File]::WriteAllText($layoutTemporary, $layoutJson + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
Move-Item -LiteralPath $layoutTemporary -Destination $layoutPath -Force
Write-Host 'AEONQUILL 完整离线阶段包安装完成。' -ForegroundColor Green
Write-Host "应用：$applicationDirectory"
Write-Host "用户数据：$appDataRoot"
Write-Host "运行时：$selectedRuntime"
if (-not $NoLaunch) {
  Start-Process -FilePath $appExecutable | Out-Null
}
