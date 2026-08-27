[CmdletBinding()]
param(
  [string]$SignerName = 'falling feather制作'
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$packageMetadata = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$productVersion = [string]$packageMetadata.version
if ($productVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
  throw "package.json 产品版本无效：$productVersion"
}
$sourceSidecar = Join-Path $projectRoot 'desktop\tauri\src-tauri\binaries\aeonquill-bridge-x86_64-pc-windows-msvc.exe'
$targetRelease = Join-Path $projectRoot 'desktop\tauri\src-tauri\target\release'
$builtApplication = Join-Path $targetRelease 'aeonquill-desktop.exe'
$bundledSidecar = Join-Path $targetRelease 'aeonquill-bridge.exe'
$installer = Join-Path $targetRelease ("bundle\nsis\AEONQUILL_{0}_x64-setup.exe" -f $productVersion)
$signingRoot = Join-Path ([IO.Path]::GetPathRoot($projectRoot)) 'AEONQUILL-SIGNING-TEMP'
$signingConfig = Join-Path $signingRoot 'tauri-self-signing.json'
$buildTempRoot = Join-Path ([IO.Path]::GetPathRoot($projectRoot)) 'AEONQUILL-BUILD-TEMP'
$certificateThumbprint = $null
$previousConfig = $env:AEONQUILL_TAURI_CONFIG
$previousTemp = $env:TEMP
$previousTmp = $env:TMP

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

function New-TemporaryCodeSigningCertificate {
  param([string]$ExpectedSigner)

  $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $cleanModulePath = @(
    (Join-Path $env:USERPROFILE 'Documents\WindowsPowerShell\Modules'),
    (Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules'),
    (Join-Path $env:SystemRoot 'system32\WindowsPowerShell\v1.0\Modules')
  ) -join ';'
  $bootstrap = @'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$certificate = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject "CN=$env:AEONQUILL_TEMP_SIGNER_NAME" `
  -FriendlyName 'AEONQUILL local test code signing' `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyAlgorithm RSA `
  -KeyLength 3072 `
  -HashAlgorithm SHA256 `
  -KeyExportPolicy NonExportable `
  -NotAfter (Get-Date).AddYears(3)
[Console]::Out.WriteLine($certificate.Thumbprint)
'@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bootstrap))
  $previousModulePath = $env:PSModulePath
  $previousSignerName = $env:AEONQUILL_TEMP_SIGNER_NAME
  try {
    $env:PSModulePath = $cleanModulePath
    $env:AEONQUILL_TEMP_SIGNER_NAME = $ExpectedSigner
    $output = @(& $windowsPowerShell -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand $encoded)
    if ($LASTEXITCODE -ne 0) {
      throw "隔离证书创建进程失败：$LASTEXITCODE"
    }
    $thumbprint = [string]($output | Where-Object { [string]$_ -match '^[0-9A-Fa-f]{40}$' } | Select-Object -Last 1)
    if ([string]::IsNullOrWhiteSpace($thumbprint)) {
      throw "隔离证书创建进程未返回有效 thumbprint：$($output -join ' ')"
    }

    $store = New-Object Security.Cryptography.X509Certificates.X509Store(
      [Security.Cryptography.X509Certificates.StoreName]::My,
      [Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
    )
    try {
      $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
      $matches = $store.Certificates.Find(
        [Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
        $thumbprint,
        $false
      )
      if ($matches.Count -ne 1 -or -not $matches[0].HasPrivateKey -or -not $matches[0].Subject.Contains($ExpectedSigner)) {
        throw '隔离创建的签名证书无法由当前进程验证。'
      }
    } finally {
      $store.Close()
    }
    return $thumbprint.ToUpperInvariant()
  } finally {
    $env:PSModulePath = $previousModulePath
    if ([string]::IsNullOrWhiteSpace($previousSignerName)) {
      Remove-Item Env:\AEONQUILL_TEMP_SIGNER_NAME -ErrorAction SilentlyContinue
    } else {
      $env:AEONQUILL_TEMP_SIGNER_NAME = $previousSignerName
    }
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
  try {
    $rawCertificate = [Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($Path)
    $signerCertificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2($rawCertificate)
  } catch {
    throw "文件没有 Authenticode 签名：$Path"
  }
  $subject = [string]$signerCertificate.Subject
  if (-not $subject.Contains($ExpectedSigner)) {
    throw "签名主体不符合预期：$Path；实际为 $subject"
  }
  [pscustomobject]@{
    Path = $Path
    Status = 'EmbeddedSignature'
    Subject = $subject
    Thumbprint = [string]$signerCertificate.Thumbprint
  }
}

try {
  $gitStatus = (& git.exe -C $projectRoot status --porcelain=v1 --untracked-files=all) -join "`n"
  if (-not [string]::IsNullOrWhiteSpace($gitStatus)) {
    throw '签名发布必须从干净 Git 工作树构建；请先提交本任务源码与文档。'
  }

  New-Item -ItemType Directory -Force -Path $buildTempRoot | Out-Null
  $env:TEMP = $buildTempRoot
  $env:TMP = $buildTempRoot

  Write-Host '正在构建自包含 Node sidecar 与前端…'
  & (Get-Command npm.cmd).Source run build:desktop:sidecar
  if ($LASTEXITCODE -ne 0) { throw "Sidecar 构建失败：$LASTEXITCODE" }

  $certificateThumbprint = New-TemporaryCodeSigningCertificate -ExpectedSigner $SignerName

  $signTool = Find-SignTool
  & $signTool sign /sha1 $certificateThumbprint /fd SHA256 /v $sourceSidecar
  if ($LASTEXITCODE -ne 0) { throw "Sidecar 签名失败：$LASTEXITCODE" }

  New-Item -ItemType Directory -Force -Path $signingRoot | Out-Null
  $config = [ordered]@{
    bundle = [ordered]@{
      windows = [ordered]@{
        certificateThumbprint = $certificateThumbprint
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

  try {
    $builtSigner = [Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($builtApplication)
    $builtSignerCertificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2($builtSigner)
  } catch {
    $builtSignerCertificate = $null
  }
  if ($null -eq $builtSignerCertificate -or -not $builtSignerCertificate.Subject.Contains($SignerName)) {
    Write-Host 'Tauri 构建目录主程序需要在 NSIS 收尾后补签…'
    & $signTool sign /sha1 $certificateThumbprint /fd SHA256 /v $builtApplication
    if ($LASTEXITCODE -ne 0) { throw "主程序补签失败：$LASTEXITCODE" }
  }

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
  if ([string]::IsNullOrWhiteSpace($previousTemp)) {
    Remove-Item Env:\TEMP -ErrorAction SilentlyContinue
  } else {
    $env:TEMP = $previousTemp
  }
  if ([string]::IsNullOrWhiteSpace($previousTmp)) {
    Remove-Item Env:\TMP -ErrorAction SilentlyContinue
  } else {
    $env:TMP = $previousTmp
  }
  Remove-Item -LiteralPath $signingConfig -Force -ErrorAction SilentlyContinue
  if ((Test-Path -LiteralPath $signingRoot) -and @((Get-ChildItem -LiteralPath $signingRoot -Force)).Count -eq 0) {
    Remove-Item -LiteralPath $signingRoot -Force -ErrorAction SilentlyContinue
  }
  if (-not [string]::IsNullOrWhiteSpace($certificateThumbprint)) {
    Remove-TemporaryCertificate -Thumbprint $certificateThumbprint
  }
  $resolvedBuildTemp = [IO.Path]::GetFullPath($buildTempRoot).TrimEnd('\')
  $expectedBuildTemp = (Join-Path ([IO.Path]::GetPathRoot($projectRoot)) 'AEONQUILL-BUILD-TEMP').TrimEnd('\')
  if ($resolvedBuildTemp -ieq $expectedBuildTemp -and (Test-Path -LiteralPath $resolvedBuildTemp)) {
    Remove-Item -LiteralPath $resolvedBuildTemp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
