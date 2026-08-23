[CmdletBinding()]
param(
  [string]$SignerName = 'falling feather制作'
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourceSidecar = Join-Path $projectRoot 'desktop\tauri\src-tauri\binaries\aeonquill-bridge-x86_64-pc-windows-msvc.exe'
$targetRelease = Join-Path $projectRoot 'desktop\tauri\src-tauri\target\release'
$builtApplication = Join-Path $targetRelease 'aeonquill-desktop.exe'
$bundledSidecar = Join-Path $targetRelease 'aeonquill-bridge.exe'
$installer = Join-Path $targetRelease 'bundle\nsis\AEONQUILL_0.6.0_x64-setup.exe'
$signingRoot = Join-Path $projectRoot '.runtime\signing'
$signingConfig = Join-Path $signingRoot 'tauri-self-signing.json'
$certificate = $null
$previousConfig = $env:AEONQUILL_TAURI_CONFIG

function Find-SignTool {
  $sdkRoot = 'C:\Program Files (x86)\Windows Kits\10\bin'
  $matches = @(Get-ChildItem -LiteralPath $sdkRoot -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
    Sort-Object FullName -Descending)
  if ($matches.Count -eq 0) {
    throw 'Windows SDK x64 signtool.exe was not found.'
  }
  return $matches[0].FullName
}

function Ensure-CertificateDrive {
  Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
  if ($null -eq (Get-PSDrive -Name 'Cert' -ErrorAction SilentlyContinue)) {
    New-PSDrive -Name 'Cert' -PSProvider 'Certificate' -Root '\' -Scope Script | Out-Null
  }
}

function Remove-TemporaryCertificate {
  param([string]$Thumbprint)
  if ([string]::IsNullOrWhiteSpace($Thumbprint)) { return }

  $store = New-Object Security.Cryptography.X509Certificates.X509Store(
    [Security.Cryptography.X509Certificates.StoreName]::My,
    [Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
  )
  try {
    $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $matches = $store.Certificates.Find(
      [Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
      $Thumbprint,
      $false
    )
    foreach ($match in $matches) {
      $store.Remove($match)
    }
  } finally {
    $store.Close()
  }
}

function Assert-SelfSignedArtifact {
  param([string]$Path, [string]$ExpectedSigner)
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($null -eq $signature.SignerCertificate) {
    throw "文件没有 Authenticode 签名：$Path"
  }
  $subject = [string]$signature.SignerCertificate.Subject
  if (-not $subject.Contains($ExpectedSigner)) {
    throw "签名主体不符合预期：$Path；实际为 $subject"
  }
  [pscustomobject]@{
    Path = $Path
    Status = [string]$signature.Status
    Subject = $subject
    Thumbprint = [string]$signature.SignerCertificate.Thumbprint
  }
}

try {
  $gitStatus = (& git.exe -C $projectRoot status --porcelain=v1 --untracked-files=all) -join "`n"
  if (-not [string]::IsNullOrWhiteSpace($gitStatus)) {
    throw '签名发布必须从干净 Git 工作树构建；请先提交本任务源码与文档。'
  }

  Write-Host '正在构建自包含 Node sidecar 与前端…'
  & (Get-Command npm.cmd).Source run build:desktop:sidecar
  if ($LASTEXITCODE -ne 0) { throw "Sidecar 构建失败：$LASTEXITCODE" }

  Ensure-CertificateDrive
  $certificate = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject "CN=$SignerName" `
    -FriendlyName 'AEONQUILL local test code signing' `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy NonExportable `
    -NotAfter (Get-Date).AddYears(3)
  if ($null -eq $certificate -or [string]::IsNullOrWhiteSpace([string]$certificate.Thumbprint)) {
    throw '无法创建临时的 AEONQUILL 自签名证书。'
  }

  $signTool = Find-SignTool
  & $signTool sign /sha1 $certificate.Thumbprint /fd SHA256 /v $sourceSidecar
  if ($LASTEXITCODE -ne 0) { throw "Sidecar 签名失败：$LASTEXITCODE" }

  New-Item -ItemType Directory -Force -Path $signingRoot | Out-Null
  $config = [ordered]@{
    bundle = [ordered]@{
      windows = [ordered]@{
        certificateThumbprint = [string]$certificate.Thumbprint
        digestAlgorithm = 'sha256'
        timestampUrl = $null
      }
    }
  }
  [IO.File]::WriteAllText(
    $signingConfig,
    (($config | ConvertTo-Json -Depth 6) + [Environment]::NewLine),
    (New-Object Text.UTF8Encoding($false))
  )
  $env:AEONQUILL_TAURI_CONFIG = $signingConfig

  Write-Host '正在构建并签名 Tauri 应用与 NSIS 安装器…'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $projectRoot 'scripts\tauri-toolchain.ps1') bundle
  if ($LASTEXITCODE -ne 0) { throw "Tauri 签名构建失败：$LASTEXITCODE" }

  $reports = @(
    Assert-SelfSignedArtifact -Path $builtApplication -ExpectedSigner $SignerName
    Assert-SelfSignedArtifact -Path $bundledSidecar -ExpectedSigner $SignerName
    Assert-SelfSignedArtifact -Path $installer -ExpectedSigner $SignerName
  )
  $reports | Format-Table Path, Status, Subject -AutoSize

  & (Get-Command node.exe).Source (Join-Path $projectRoot 'scripts\stage-desktop-release.mjs')
  if ($LASTEXITCODE -ne 0) { throw "桌面发布目录整理失败：$LASTEXITCODE" }
  Write-Host "AEONQUILL 安装器已由 $SignerName 自签名；证书私钥不会进入发行包。" -ForegroundColor Green
} finally {
  if ([string]::IsNullOrWhiteSpace($previousConfig)) {
    Remove-Item Env:\AEONQUILL_TAURI_CONFIG -ErrorAction SilentlyContinue
  } else {
    $env:AEONQUILL_TAURI_CONFIG = $previousConfig
  }
  Remove-Item -LiteralPath $signingConfig -Force -ErrorAction SilentlyContinue
  if ($null -ne $certificate -and -not [string]::IsNullOrWhiteSpace([string]$certificate.Thumbprint)) {
    Remove-TemporaryCertificate -Thumbprint ([string]$certificate.Thumbprint)
  }
}
