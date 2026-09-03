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
$buildTempRoot = Join-Path ([IO.Path]::GetPathRoot($projectRoot)) 'AEONQUILL-BUILD-TEMP'
$stagedWebView2Installer = Join-Path $buildTempRoot 'AEONQUILL-WebView2-Offline-x64.exe'
$certificateThumbprint = $null
$previousConfig = $env:AEONQUILL_TAURI_CONFIG
$previousTemp = $env:TEMP
$previousTmp = $env:TMP
$previousBuildCommit = $env:AEONQUILL_BUILD_COMMIT
$previousProductVersion = $env:AEONQUILL_PRODUCT_VERSION
$previousFunctionalTrack = $env:AEONQUILL_FUNCTIONAL_TRACK
$previousBuildIdentityVersion = $env:AEONQUILL_BUILD_IDENTITY_VERSION
$previousRuntimeRegistryVersion = $env:AEONQUILL_RUNTIME_REGISTRY_VERSION
$previousWebView2OfflineInstaller = $env:AEONQUILL_WEBVIEW2_OFFLINE_INSTALLER

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

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)

  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '')
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Get-VerifiedWebView2OfflineInstaller {
  param(
    [string]$SearchRoot,
    [string]$ExplicitCandidate
  )

  $candidatePaths = @()
  if (-not [string]::IsNullOrWhiteSpace($ExplicitCandidate)) {
    $candidatePaths = @($ExplicitCandidate)
  } elseif (Test-Path -LiteralPath $SearchRoot -PathType Container) {
    $candidatePaths = @(
      Get-ChildItem -LiteralPath $SearchRoot -Recurse -File -Filter 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe' -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName
    )
  }

  $signatureTool = Find-SignTool
  $verified = @()
  foreach ($candidatePath in $candidatePaths) {
    if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
      if (-not [string]::IsNullOrWhiteSpace($ExplicitCandidate)) {
        throw "指定的 WebView2 离线安装器不存在：$candidatePath"
      }
      continue
    }

    $item = Get-Item -LiteralPath $candidatePath
    $signatureOutput = @(& $signatureTool verify /pa /q $candidatePath 2>&1)
    $signatureValid = $LASTEXITCODE -eq 0
    try {
      $rawCertificate = [Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($candidatePath)
      $signerCertificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2($rawCertificate)
      $subject = [string]$signerCertificate.Subject
    } catch {
      $subject = ''
    }
    $isTrustedMicrosoft = (
      $item.Length -gt 50MB -and
      $signatureValid -and
      $subject -match '(^|,\s*)CN=Microsoft Corporation(,|$)'
    )
    if (-not $isTrustedMicrosoft) {
      if (-not [string]::IsNullOrWhiteSpace($ExplicitCandidate)) {
        $signatureSummary = ($signatureOutput | ForEach-Object { [string]$_ }) -join ' '
        throw "指定的 WebView2 离线安装器未通过微软 Authenticode 与体量校验：$candidatePath；$signatureSummary"
      }
      continue
    }

    try {
      $fileVersion = [version]$item.VersionInfo.FileVersion
    } catch {
      $fileVersion = [version]'0.0.0.0'
    }
    $verified += [pscustomobject]@{
      Path = $item.FullName
      Version = $fileVersion
      Bytes = $item.Length
      LastWriteTime = $item.LastWriteTimeUtc
      Sha256 = Get-Sha256Hex -Path $item.FullName
    }
  }

  if ($verified.Count -eq 0) {
    return $null
  }
  return $verified | Sort-Object Version, LastWriteTime -Descending | Select-Object -First 1
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

function Get-IsolatedAuthenticodeStatusCode {
  param([Parameter(Mandatory = $true)][string]$Path)

  $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $cleanModulePath = @(
    (Join-Path $env:USERPROFILE 'Documents\WindowsPowerShell\Modules'),
    (Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules'),
    (Join-Path $env:SystemRoot 'system32\WindowsPowerShell\v1.0\Modules')
  ) -join ';'
  $bootstrap = @'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$module = Join-Path $env:SystemRoot 'system32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
Import-Module -Name $module -Force
$signature = Get-AuthenticodeSignature -LiteralPath $env:AEONQUILL_AUTHENTICODE_PATH
[Console]::Out.WriteLine([int]$signature.Status)
'@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bootstrap))
  $previousModulePath = $env:PSModulePath
  $previousArtifactPath = $env:AEONQUILL_AUTHENTICODE_PATH
  try {
    $env:PSModulePath = $cleanModulePath
    $env:AEONQUILL_AUTHENTICODE_PATH = $Path
    $output = @(& $windowsPowerShell -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand $encoded)
    if ($LASTEXITCODE -ne 0) {
      throw "隔离 Authenticode 检查进程失败：$Path；退出码 $LASTEXITCODE"
    }
    $statusText = [string]($output | Where-Object { [string]$_ -match '^\d+$' } | Select-Object -Last 1)
    if ([string]::IsNullOrWhiteSpace($statusText)) {
      throw "隔离 Authenticode 检查未返回状态码：$Path；$($output -join ' ')"
    }
    return [int]$statusText
  } finally {
    $env:PSModulePath = $previousModulePath
    if ([string]::IsNullOrWhiteSpace($previousArtifactPath)) {
      Remove-Item Env:\AEONQUILL_AUTHENTICODE_PATH -ErrorAction SilentlyContinue
    } else {
      $env:AEONQUILL_AUTHENTICODE_PATH = $previousArtifactPath
    }
  }
}

function Assert-SelfSignedArtifact {
  param([string]$Path, [string]$ExpectedSigner, [string]$ExpectedThumbprint)
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
  if (-not [string]::IsNullOrWhiteSpace($ExpectedThumbprint) -and
      $signerCertificate.Thumbprint -ne $ExpectedThumbprint) {
    throw "签名证书不符合本次封包证书：$Path"
  }
  $codeSigningEku = @(
    $signerCertificate.Extensions |
      Where-Object { $_.Oid.Value -eq '2.5.29.37' } |
      ForEach-Object { $_.Format($false) }
  ) -join ';'
  if ($codeSigningEku -notmatch '1\.3\.6\.1\.5\.5\.7\.3\.3') {
    throw "签名证书缺少 Code Signing EKU：$Path"
  }

  # Get-AuthenticodeSignature validates the PE digest before evaluating trust.
  # A local self-signed certificate is intentionally not placed in a trusted
  # root store, so status 1 is accepted only when its chain has exactly the
  # expected UntrustedRoot condition. HashMismatch (3), NotSigned (2), and
  # every other status fail closed.
  $statusCode = Get-IsolatedAuthenticodeStatusCode -Path $Path
  $statusLabel = 'Valid'
  if ($statusCode -eq 1) {
    $chain = New-Object Security.Cryptography.X509Certificates.X509Chain
    try {
      $chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
      [void]$chain.Build($signerCertificate)
      $chainStatuses = @($chain.ChainStatus | ForEach-Object { $_.Status.ToString() })
      if ($chainStatuses.Count -ne 1 -or $chainStatuses[0] -ne 'UntrustedRoot') {
        throw "自签名链存在非预期错误：$Path；$($chainStatuses -join ',')"
      }
    } finally {
      $chain.Dispose()
    }
    $statusLabel = 'UntrustedRootOnly'
  } elseif ($statusCode -ne 0) {
    throw "Authenticode 摘要或签名状态无效：$Path；状态码 $statusCode"
  }
  [pscustomobject]@{
    Path = $Path
    Status = $statusLabel
    Subject = $subject
    Thumbprint = [string]$signerCertificate.Thumbprint
  }
}

function Set-NsisBundleType {
  param([Parameter(Mandatory = $true)][string]$Path)

  $unknownToken = '__TAURI_BUNDLE_TYPE_VAR_UNK'
  $nsisToken = '__TAURI_BUNDLE_TYPE_VAR_NSS'
  if ($unknownToken.Length -ne $nsisToken.Length) {
    throw 'Tauri bundle type tokens must have identical lengths.'
  }
  $bytes = [IO.File]::ReadAllBytes($Path)
  $latin1 = [Text.Encoding]::GetEncoding(28591)
  $source = $latin1.GetString($bytes)
  $unknownIndex = $source.IndexOf($unknownToken, [StringComparison]::Ordinal)
  $nsisIndex = $source.IndexOf($nsisToken, [StringComparison]::Ordinal)
  if ($unknownIndex -lt 0) {
    if ($nsisIndex -ge 0 -and $source.IndexOf($nsisToken, $nsisIndex + 1, [StringComparison]::Ordinal) -lt 0) {
      return
    }
    throw "主程序缺少唯一的 Tauri bundle type 占位符：$Path"
  }
  if ($source.IndexOf($unknownToken, $unknownIndex + 1, [StringComparison]::Ordinal) -ge 0 -or $nsisIndex -ge 0) {
    throw "主程序包含歧义的 Tauri bundle type 标记：$Path"
  }
  $replacement = [Text.Encoding]::ASCII.GetBytes($nsisToken)
  [Array]::Copy($replacement, 0, $bytes, $unknownIndex, $replacement.Length)
  [IO.File]::WriteAllBytes($Path, $bytes)
  $verified = $latin1.GetString([IO.File]::ReadAllBytes($Path))
  if ($verified.IndexOf($unknownToken, [StringComparison]::Ordinal) -ge 0 -or
      $verified.IndexOf($nsisToken, [StringComparison]::Ordinal) -lt 0) {
    throw "主程序 NSIS bundle type 预补丁复核失败：$Path"
  }
}

try {
  $gitStatus = (& git.exe -C $projectRoot status --porcelain=v1 --untracked-files=all) -join "`n"
  if (-not [string]::IsNullOrWhiteSpace($gitStatus)) {
    throw '签名发布必须从干净 Git 工作树构建；请先提交本任务源码与文档。'
  }
  $sourceCommit = ((& git.exe -C $projectRoot rev-parse HEAD) -join '').Trim().ToLowerInvariant()
  if ($sourceCommit -notmatch '^[a-f0-9]{40}$') {
    throw "无法解析签名发布源提交：$sourceCommit"
  }
  $env:AEONQUILL_BUILD_COMMIT = $sourceCommit
  $env:AEONQUILL_PRODUCT_VERSION = $productVersion
  $env:AEONQUILL_FUNCTIONAL_TRACK = 'V0.7.62'
  $env:AEONQUILL_BUILD_IDENTITY_VERSION = 'aeonquill-build-identity-v1'
  $env:AEONQUILL_RUNTIME_REGISTRY_VERSION = 'aeonquill-runtime-registry-v1'

  New-Item -ItemType Directory -Force -Path $buildTempRoot | Out-Null
  $env:TEMP = $buildTempRoot
  $env:TMP = $buildTempRoot

  $webView2SearchRoot = Join-Path (Split-Path -Parent $targetRelease) '.tauri\x64'
  $webView2Installer = Get-VerifiedWebView2OfflineInstaller `
    -SearchRoot $webView2SearchRoot `
    -ExplicitCandidate $previousWebView2OfflineInstaller
  if ($null -ne $webView2Installer) {
    [IO.File]::Copy($webView2Installer.Path, $stagedWebView2Installer, $true)
    $stagedWebView2Item = Get-Item -LiteralPath $stagedWebView2Installer
    $stagedWebView2Sha256 = Get-Sha256Hex -Path $stagedWebView2Installer
    if ($stagedWebView2Item.Length -ne $webView2Installer.Bytes -or $stagedWebView2Sha256 -ne $webView2Installer.Sha256) {
      throw 'WebView2 离线安装器写入纯 ASCII 构建路径后未保持逐字节一致。'
    }
    $env:AEONQUILL_WEBVIEW2_OFFLINE_INSTALLER = $stagedWebView2Installer
    Write-Host ("使用已验证的微软 WebView2 离线安装器：{0}；{1} bytes；SHA-256 {2}" -f `
      $webView2Installer.Version, $webView2Installer.Bytes, $webView2Installer.Sha256)
  } else {
    Remove-Item Env:\AEONQUILL_WEBVIEW2_OFFLINE_INSTALLER -ErrorAction SilentlyContinue
    Write-Warning '未发现已验证的 D 盘 WebView2 离线安装器；Tauri 将使用官方网络发现流程。'
  }

  Write-Host '正在构建自包含 Node sidecar 与前端…'
  & (Get-Command npm.cmd).Source run build:desktop:sidecar
  if ($LASTEXITCODE -ne 0) { throw "Sidecar 构建失败：$LASTEXITCODE" }

  $certificateThumbprint = New-TemporaryCodeSigningCertificate -ExpectedSigner $SignerName

  $signTool = Find-SignTool
  & $signTool sign /sha1 $certificateThumbprint /fd SHA256 /v $sourceSidecar
  if ($LASTEXITCODE -ne 0) { throw "Sidecar 签名失败：$LASTEXITCODE" }

  # Do not expose a certificate to Tauri's internal bundler. On this Windows
  # host its signed NSIS branch can fail before rendering installer.nsi with an
  # opaque EOF. Instead, build once without a bundle, sign the exact PE files
  # that must be embedded, bundle those already-signed files, then sign the
  # outer installer. This also prevents the bundle-only phase from rebuilding
  # and silently replacing the signed application.
  Remove-Item Env:\AEONQUILL_TAURI_CONFIG -ErrorAction SilentlyContinue
  Write-Host '正在构建未分包的 Tauri release…'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $projectRoot 'scripts\tauri-toolchain.ps1') release
  if ($LASTEXITCODE -ne 0) { throw "Tauri release 构建失败：$LASTEXITCODE" }

  # Tauri patches this token after entering `bundle`, which invalidates an
  # already-signed PE before NSIS copies it and then restores the source file.
  # Patch the unsigned release first so the bundle step is idempotent and the
  # exact signed bytes enter the installer.
  Set-NsisBundleType -Path $builtApplication

  foreach ($artifact in @(
    @{ Path = $builtApplication; Label = '主程序' },
    @{ Path = $bundledSidecar; Label = '分包 sidecar' }
  )) {
    & $signTool sign /sha1 $certificateThumbprint /fd SHA256 /v $artifact.Path
    if ($LASTEXITCODE -ne 0) { throw "$($artifact.Label)签名失败：$LASTEXITCODE" }
    Assert-SelfSignedArtifact -Path $artifact.Path -ExpectedSigner $SignerName -ExpectedThumbprint $certificateThumbprint | Out-Null
  }

  Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
  Write-Host '正在将已签署主程序与 sidecar 封入 NSIS…'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $projectRoot 'scripts\tauri-toolchain.ps1') bundle-existing
  if ($LASTEXITCODE -ne 0) { throw "Tauri NSIS 分包失败：$LASTEXITCODE" }
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "Tauri NSIS 分包未生成预期安装器：$installer"
  }
  & $signTool sign /sha1 $certificateThumbprint /fd SHA256 /v $installer
  if ($LASTEXITCODE -ne 0) { throw "安装器签名失败：$LASTEXITCODE" }

  $reports = @(
    Assert-SelfSignedArtifact -Path $builtApplication -ExpectedSigner $SignerName -ExpectedThumbprint $certificateThumbprint
    Assert-SelfSignedArtifact -Path $bundledSidecar -ExpectedSigner $SignerName -ExpectedThumbprint $certificateThumbprint
    Assert-SelfSignedArtifact -Path $installer -ExpectedSigner $SignerName -ExpectedThumbprint $certificateThumbprint
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
  foreach ($entry in @(
    @{ Name = 'AEONQUILL_BUILD_COMMIT'; Value = $previousBuildCommit },
    @{ Name = 'AEONQUILL_PRODUCT_VERSION'; Value = $previousProductVersion },
    @{ Name = 'AEONQUILL_FUNCTIONAL_TRACK'; Value = $previousFunctionalTrack },
    @{ Name = 'AEONQUILL_BUILD_IDENTITY_VERSION'; Value = $previousBuildIdentityVersion },
    @{ Name = 'AEONQUILL_RUNTIME_REGISTRY_VERSION'; Value = $previousRuntimeRegistryVersion },
    @{ Name = 'AEONQUILL_WEBVIEW2_OFFLINE_INSTALLER'; Value = $previousWebView2OfflineInstaller }
  )) {
    if ([string]::IsNullOrWhiteSpace([string]$entry.Value)) {
      Remove-Item ("Env:\{0}" -f $entry.Name) -ErrorAction SilentlyContinue
    } else {
      Set-Item ("Env:\{0}" -f $entry.Name) ([string]$entry.Value)
    }
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
