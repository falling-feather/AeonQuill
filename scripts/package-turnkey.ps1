[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$downloadRoot = Join-Path $projectRoot '下载'
$finalRoot = Join-Path $downloadRoot '光阴砚AEONQUILL-0.6.0-Windows-x64-开箱即用版'
$runtimePackage = Join-Path $finalRoot 'runtime\aeonquill-comfyui-h3-cu130-win-x64-v3'

function Invoke-NpmScript {
  param([string]$Name)
  & (Get-Command npm.cmd).Source run $Name
  if ($LASTEXITCODE -ne 0) { throw "npm run $Name 失败：$LASTEXITCODE" }
}

function Remove-WorkspaceArtifact {
  param([string]$Path)
  $workspace = [IO.Path]::GetFullPath($projectRoot).TrimEnd('\') + '\'
  $target = [IO.Path]::GetFullPath($Path)
  if (-not $target.StartsWith($workspace, [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝清理工作区以外路径：$target"
  }
  if ($target -eq [IO.Path]::GetFullPath($projectRoot) -or $target -eq [IO.Path]::GetFullPath($downloadRoot)) {
    throw "拒绝清理过宽目录：$target"
  }
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Host "已清理旧发布路径：$target"
  }
}

Write-Host '阶段 1/5：构建并自签名桌面应用'
Invoke-NpmScript 'package:desktop:signed'

Write-Host '阶段 2/5：构建独立 Python / ComfyUI / H3 / SeedVR2 运行时'
& (Get-Command node.exe).Source (Join-Path $projectRoot 'scripts\stage-offline-runtime.mjs') "--output=$runtimePackage"
if ($LASTEXITCODE -ne 0) { throw "运行时封装失败：$LASTEXITCODE" }
& (Get-Command node.exe).Source (Join-Path $projectRoot 'scripts\validate-offline-runtime.mjs') "--root=$runtimePackage"
if ($LASTEXITCODE -ne 0) { throw "运行时关键校验失败：$LASTEXITCODE" }

Write-Host '阶段 3/5：绑定应用、运行时、许可与安装入口'
Invoke-NpmScript 'stage:desktop:full-offline'
Invoke-NpmScript 'validate:desktop:release-manifest'
Invoke-NpmScript 'validate:desktop:full-offline'
Invoke-NpmScript 'validate:desktop:turnkey-boundary'

Write-Host '阶段 4/5：后台冷启动 ComfyUI 与 packaged sidecar'
& (Get-Command node.exe).Source (Join-Path $projectRoot 'scripts\validate-offline-comfy.mjs') "--root=$runtimePackage"
if ($LASTEXITCODE -ne 0) { throw "ComfyUI 冷启动验证失败：$LASTEXITCODE" }
& (Get-Command node.exe).Source (Join-Path $projectRoot 'scripts\validate-offline-sidecar.mjs') "--root=$runtimePackage"
if ($LASTEXITCODE -ne 0) { throw "Sidecar 运行时验证失败：$LASTEXITCODE" }
& (Get-Command node.exe).Source (Join-Path $projectRoot 'scripts\validate-offline-runtime.mjs') "--root=$runtimePackage" --full
if ($LASTEXITCODE -ne 0) { throw "运行时全树校验失败：$LASTEXITCODE" }

Write-Host '阶段 5/5：成功后清理历史安装包与中间发布目录'
New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null
foreach ($entry in Get-ChildItem -LiteralPath $downloadRoot -Force) {
  if ([IO.Path]::GetFullPath($entry.FullName) -ne [IO.Path]::GetFullPath($finalRoot)) {
    Remove-WorkspaceArtifact -Path $entry.FullName
  }
}
foreach ($oldPath in @(
  (Join-Path $projectRoot '.runtime\releases\offline'),
  (Join-Path $projectRoot '.runtime\releases\electron'),
  (Join-Path $projectRoot '.runtime\releases\staging'),
  (Join-Path $projectRoot 'desktop\tauri\src-tauri\target\release\bundle\nsis')
)) {
  Remove-WorkspaceArtifact -Path $oldPath
}

Write-Host "开箱即用版已完成：$finalRoot" -ForegroundColor Green
Write-Host '下载目录仅保留本次交付；用户项目、本地数据库、生成结果与签名私钥均未进入包体。'
