import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadReleaseMetadata, resolveReleasePaths } from '../desktop/release/release-meta.mjs'
import { validateReleaseManifestShape } from '../desktop/release/manifest-contract.mjs'
import { FUNCTIONAL_TRACK } from '../desktop/release/product-identity.mjs'
import {
  DURABLE_USER_DATA_MARKERS,
  selectElectronUserDataDirectory,
} from '../desktop/shared/user-data-compat.mjs'
import {
  parsePortableLayout,
  PORTABLE_LAYOUT_FILENAME,
  resolvePortableDataDirectory,
} from '../desktop/shared/portable-layout.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))

test('desktop release identity and version mirrors resolve from package.json', async () => {
  const metadata = await loadReleaseMetadata(projectRoot)
  const paths = resolveReleasePaths(metadata)
  const [tauriConfig, cargoSource, mainSource, tauriSource, electronSource, sidecarConfig, sidecarBuildSource] = await Promise.all([
    readFile(join(projectRoot, 'desktop', 'tauri', 'src-tauri', 'tauri.conf.json'), 'utf8').then(JSON.parse),
    readFile(join(projectRoot, 'desktop', 'tauri', 'src-tauri', 'Cargo.toml'), 'utf8'),
    readFile(join(projectRoot, 'desktop', 'tauri', 'src-tauri', 'src', 'main.rs'), 'utf8'),
    readFile(join(projectRoot, 'desktop', 'tauri', 'src-tauri', 'src', 'lib.rs'), 'utf8'),
    readFile(join(projectRoot, 'desktop', 'electron', 'main.mjs'), 'utf8'),
    readFile(join(projectRoot, 'desktop', 'sidecar.pkg.json'), 'utf8').then(JSON.parse),
    readFile(join(projectRoot, 'scripts', 'build-node-sidecar.mjs'), 'utf8'),
  ])

  assert.equal(metadata.productName, 'AEONQUILL')
  assert.equal(metadata.displayName, '光阴砚 AEONQUILL')
  assert.equal(metadata.version, '0.7.1')
  assert.equal(metadata.functionalTrack, FUNCTIONAL_TRACK)
  assert.equal(metadata.buildIdentityVersion, 'aeonquill-build-identity-v1')
  assert.equal(metadata.runtimeRegistryVersion, 'aeonquill-runtime-registry-v1')
  assert.equal(metadata.identifier, 'com.miaohui.desktop')
  assert.equal(metadata.identifierMigrationStatus, 'legacy-preserved-for-data-continuity')
  assert.equal(tauriConfig.version, '../../../package.json')
  assert.equal(tauriConfig.bundle.useLocalToolsDir, true)
  assert.equal(tauriConfig.bundle.publisher, 'falling feather制作')
  assert.deepEqual(tauriConfig.bundle.resources, {
    '../../release/INSTALL.zh-CN.md': 'release/INSTALL.zh-CN.md',
    '../../release/LIMITATIONS.zh-CN.md': 'release/LIMITATIONS.zh-CN.md',
    '../../release/THIRD-PARTY-NOTICES.md': 'release/THIRD-PARTY-NOTICES.md',
  })
  assert.match(cargoSource, /^name = "aeonquill-desktop"$/m)
  assert.match(cargoSource, /^version = "0\.7\.1"$/m)
  assert.match(cargoSource, /^tauri-plugin-single-instance = "2"$/m)
  assert.match(mainSource, /aeonquill_desktop_lib::run\(\)/)
  assert.match(tauriSource, /\.sidecar\("aeonquill-bridge"\)/)
  assert.ok(tauriSource.includes(`const FUNCTIONAL_TRACK: &str = "${metadata.functionalTrack}";`))
  assert.match(tauriSource, /option_env!\("AEONQUILL_BUILD_COMMIT"\)/)
  assert.ok(sidecarConfig.assets.includes('../.runtime/release/embedded-build-identity.json'))
  assert.match(sidecarBuildSource, /status', '--porcelain=v1', '--untracked-files=all'/u)
  assert.match(sidecarBuildSource, /self-contained sidecar must be packaged from a clean Git worktree/u)
  assert.match(sidecarBuildSource, /AEONQUILL_BUILD_COMMIT does not match clean HEAD/u)
  assert.match(tauriSource, /\.title\("光阴砚 AEONQUILL"\)/)
  assert.match(tauriSource, /close_window\.close\(\)/)
  assert.match(tauriSource, /tauri::RunEvent::WindowEvent/)
  assert.match(tauriSource, /tauri::WindowEvent::CloseRequested/)
  assert.match(tauriSource, /app_handle\.exit\(0\)/)
  const singleInstanceAt = tauriSource.indexOf('.plugin(tauri_plugin_single_instance::init(')
  const shellPluginAt = tauriSource.indexOf('.plugin(tauri_plugin_shell::init())')
  const setupAt = tauriSource.indexOf('.setup(move |app| setup_desktop(')
  assert.ok(singleInstanceAt >= 0, 'Tauri must register the single-instance plugin')
  assert.ok(singleInstanceAt < shellPluginAt, 'The single-instance lock must be the first plugin')
  assert.ok(singleInstanceAt < setupAt, 'The single-instance lock must be acquired before desktop setup')
  assert.match(tauriSource, /window\.unminimize\(\)/)
  assert.match(tauriSource, /window\.set_focus\(\)/)
  assert.match(tauriSource, /default_data_directory\.join\("EBWebView"\)/)
  assert.match(tauriSource, /\.data_directory\(webview_data_directory\)/)
  for (const key of [
    'AEONQUILL_PRODUCT_VERSION',
    'AEONQUILL_FUNCTIONAL_TRACK',
    'AEONQUILL_BUILD_IDENTITY_VERSION',
    'AEONQUILL_RUNTIME_REGISTRY_VERSION',
    'AEONQUILL_BUILD_COMMIT',
  ]) assert.match(tauriSource, new RegExp(key))
  for (const key of [
    'AEONQUILL_RUNTIME_DIR',
    'AEONQUILL_DATA_DIR',
    'AEONQUILL_CACHE_DIR',
    'AEONQUILL_LOG_DIR',
    'AEONQUILL_CONFIG',
    'AEONQUILL_REMBG_PATH',
    'AEONQUILL_REMBG_MODELS',
    'AEONQUILL_REALESRGAN_PATH',
    'AEONQUILL_REALESRGAN_MODELS',
  ]) {
    assert.match(tauriSource, new RegExp(key))
    assert.match(electronSource, new RegExp(key))
  }
  assert.equal(basename(paths.installer), 'AEONQUILL_0.7.1_x64-setup.exe')
  assert.equal(basename(paths.builtApp), 'aeonquill-desktop.exe')
  assert.equal(basename(paths.bundledSidecar), 'aeonquill-bridge.exe')
})

test('Electron preserves legacy user data only when the AEONQUILL location is still empty', () => {
  const current = join(projectRoot, '.test-paths', 'AEONQUILL')
  const legacy = join(projectRoot, '.test-paths', 'MiaoHui')
  const explicit = join(projectRoot, '.test-paths', 'isolated-user-data')
  const existing = new Set([join(legacy, DURABLE_USER_DATA_MARKERS[5])])
  const pathExists = (pathname) => existing.has(pathname)

  assert.deepEqual(
    selectElectronUserDataDirectory({
      defaultDirectory: current,
      legacyDirectory: legacy,
      pathExists,
    }),
    { directory: legacy, layout: 'legacy-miaohui-preserved' },
  )

  existing.add(join(current, DURABLE_USER_DATA_MARKERS[1]))
  assert.deepEqual(
    selectElectronUserDataDirectory({
      defaultDirectory: current,
      legacyDirectory: legacy,
      pathExists,
    }),
    { directory: current, layout: 'aeonquill' },
  )
  assert.deepEqual(
    selectElectronUserDataDirectory({
      defaultDirectory: current,
      legacyDirectory: legacy,
      explicitDirectory: explicit,
      pathExists,
    }),
    { directory: explicit, layout: 'explicit' },
  )
  assert.deepEqual(
    selectElectronUserDataDirectory({
      defaultDirectory: current,
      legacyDirectory: legacy,
      portableDirectory: join(projectRoot, '.test-paths', 'portable', 'UserData'),
      pathExists,
    }),
    {
      directory: join(projectRoot, '.test-paths', 'portable', 'UserData'),
      layout: 'portable-sibling-user-data',
    },
  )
  assert.deepEqual(
    selectElectronUserDataDirectory({
      defaultDirectory: current,
      legacyDirectory: legacy,
      storagePathsExplicit: true,
      pathExists,
    }),
    { directory: current, layout: 'aeonquill-explicit-storage' },
  )
})

test('Electron treats a standalone job archive as durable user data', () => {
  const current = join(projectRoot, '.test-paths', 'AEONQUILL-archive-only')
  const legacy = join(projectRoot, '.test-paths', 'MiaoHui-archive-only')
  const archiveMarker = DURABLE_USER_DATA_MARKERS.find((marker) => marker === join('runtime', 'job-archive.json'))
  assert.ok(archiveMarker)

  assert.deepEqual(
    selectElectronUserDataDirectory({
      defaultDirectory: current,
      legacyDirectory: legacy,
      pathExists: (pathname) => pathname === join(legacy, archiveMarker),
    }),
    { directory: legacy, layout: 'legacy-miaohui-preserved' },
  )
})

test('portable desktop layout is strict and resolves UserData beside App', () => {
  const applicationDirectory = join(projectRoot, '.test-paths', 'portable', 'App')
  const markerPath = join(applicationDirectory, PORTABLE_LAYOUT_FILENAME)
  const source = JSON.stringify({
    schemaVersion: 1,
    layout: 'sibling-user-data',
    dataDirectoryName: 'UserData',
  })
  assert.deepEqual(parsePortableLayout(source), JSON.parse(source))
  assert.deepEqual(
    resolvePortableDataDirectory({
      executableDirectory: applicationDirectory,
      pathExists: (pathname) => pathname === markerPath,
      readText: () => source,
    }),
    {
      directory: join(projectRoot, '.test-paths', 'portable', 'UserData'),
      layout: 'portable-sibling-user-data',
      markerPath,
    },
  )
  assert.throws(
    () => parsePortableLayout(JSON.stringify({
      schemaVersion: 1,
      layout: 'sibling-user-data',
      dataDirectoryName: '..\\private',
    })),
    /must be UserData/,
  )
  assert.throws(
    () => parsePortableLayout(JSON.stringify({
      schemaVersion: 1,
      layout: 'sibling-user-data',
      dataDirectoryName: 'UserData',
      leakedField: true,
    })),
    /must contain exactly/,
  )
})

test('packaging scripts contain no legacy MiaoHui artifact identities', async () => {
  const files = [
    'scripts/build-node-sidecar.mjs',
    'scripts/package-electron.mjs',
    'scripts/validate-desktop-electron.mjs',
    'scripts/validate-desktop-tauri.mjs',
    'scripts/validate-desktop-single-instance.mjs',
    'scripts/validate-node-sidecar.mjs',
    'scripts/validate-tauri-installer.mjs',
    'scripts/benchmark-desktop-shells.mjs',
    'desktop/electron/main.mjs',
    'desktop/tauri/src-tauri/tauri.conf.json',
  ]
  const combined = (await Promise.all(files.map((file) => readFile(join(projectRoot, file), 'utf8')))).join('\n')
  for (const legacyPattern of [
    /MiaoHui_0\.1\.0/,
    /MiaoHui-win32-x64/,
    /MiaoHui\.exe/,
    /miaohui-desktop\.exe/,
    /miaohui-bridge-x86_64/,
  ]) {
    assert.doesNotMatch(combined, legacyPattern)
  }
  assert.match(combined, /MIAOHUI_RUNTIME_DIR/, 'Legacy MIAOHUI_* compatibility input must remain available')
})

test('lightweight release fails closed unless the packaged sidecar and hidden Tauri lifecycle pass', async () => {
  const packageSource = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  const command = packageSource.scripts['package:desktop:lightweight']
  const signedAt = command.indexOf('package:desktop:signed')
  const sidecarAt = command.indexOf('validate:desktop:sidecar')
  const tauriAt = command.indexOf('validate:desktop:tauri:release')
  const singleInstanceAt = command.indexOf('validate:desktop:single-instance:release')
  const stageAt = command.indexOf('stage:desktop:lightweight')
  assert.ok(signedAt >= 0 && sidecarAt > signedAt)
  assert.ok(tauriAt > sidecarAt)
  assert.ok(singleInstanceAt > tauriAt)
  assert.ok(
    stageAt > singleInstanceAt,
    'Download staging must happen only after sidecar, lifecycle, and single-instance gates pass',
  )
})

test('packaged sidecar validation imports its identity reader and waits before cleanup', async () => {
  const source = await readFile(join(projectRoot, 'scripts', 'validate-node-sidecar.mjs'), 'utf8')
  assert.match(source, /import \{[^}]*readFile[^}]*\} from 'node:fs\/promises'/s)
  assert.match(source, /async function terminateChild\(child\)/)
  assert.match(source, /await terminateChild\(child\)/)
  assert.match(source, /maxRetries: 10/)
  assert.match(source, /retryDelay: 100/)
})

test('signed desktop build reuses only a trusted Microsoft WebView2 offline installer', async () => {
  const [source, toolchainSource] = await Promise.all([
    readFile(join(projectRoot, 'scripts', 'package-signed-desktop.ps1'), 'utf8'),
    readFile(join(projectRoot, 'scripts', 'tauri-toolchain.ps1'), 'utf8'),
  ])
  const webViewVerifier = source.slice(
    source.indexOf('function Get-VerifiedWebView2OfflineInstaller'),
    source.indexOf('function New-TemporaryCodeSigningCertificate'),
  )
  assert.match(source, /AEONQUILL_WEBVIEW2_OFFLINE_INSTALLER/)
  assert.match(source, /verify \/pa \/q/)
  assert.match(source, /CreateFromSignedFile/)
  assert.doesNotMatch(webViewVerifier, /Get-AuthenticodeSignature/)
  assert.match(source, /CN=Microsoft Corporation/)
  assert.match(source, /Get-Sha256Hex/)
  assert.match(source, /SHA256\]::Create/)
  assert.doesNotMatch(source, /Get-FileHash/)
  assert.match(source, /previousWebView2OfflineInstaller/)
  assert.match(source, /AEONQUILL-WebView2-Offline-x64\.exe/)
  assert.match(source, /\[IO\.File\]::Copy/)
  assert.match(source, /写入纯 ASCII 构建路径后未保持逐字节一致/)
  assert.match(toolchainSource, /AEONQUILL_WEBVIEW2_OFFLINE_INSTALLER/)
  assert.match(toolchainSource, /Get-AeonquillSha256Hex/)
  assert.match(toolchainSource, /SHA256\]::Create/)
  assert.doesNotMatch(toolchainSource, /Get-FileHash/)
  assert.match(toolchainSource, /3ED4C56DE9F5FC1F98D2C335A88D0E871AB5389EE27FC047EC290E4BC2B60009/)
  assert.match(toolchainSource, /tauri-cli 2\.11\.4/)
})

test('signed desktop build signs payloads before an isolated bundle-only phase', async () => {
  const [source, toolchainSource] = await Promise.all([
    readFile(join(projectRoot, 'scripts', 'package-signed-desktop.ps1'), 'utf8'),
    readFile(join(projectRoot, 'scripts', 'tauri-toolchain.ps1'), 'utf8'),
  ])
  const releaseAt = source.indexOf("tauri-toolchain.ps1') release")
  const bundleTypePatchAt = source.indexOf('Set-NsisBundleType -Path $builtApplication')
  const applicationSignAt = source.indexOf("@{ Path = $builtApplication")
  const staleInstallerRemovalAt = source.indexOf('Remove-Item -LiteralPath $installer')
  const bundleAt = source.indexOf("tauri-toolchain.ps1') bundle-existing")
  const installerSignAt = source.lastIndexOf('& $signTool sign')
  assert.ok(releaseAt >= 0)
  assert.ok(bundleTypePatchAt > releaseAt)
  assert.ok(applicationSignAt > bundleTypePatchAt)
  assert.ok(staleInstallerRemovalAt > applicationSignAt)
  assert.ok(bundleAt > staleInstallerRemovalAt)
  assert.ok(installerSignAt > bundleAt)
  assert.match(source, /Remove-Item Env:\\AEONQUILL_TAURI_CONFIG/)
  assert.match(source, /__TAURI_BUNDLE_TYPE_VAR_UNK/)
  assert.match(source, /__TAURI_BUNDLE_TYPE_VAR_NSS/)
  assert.match(source, /Get-IsolatedAuthenticodeStatusCode/)
  assert.match(source, /UntrustedRootOnly/)
  assert.match(source, /HashMismatch \(3\)/)
  assert.match(source, /Authenticode 摘要或签名状态无效/)
  assert.doesNotMatch(source, /tauri-self-signing\.json/)
  assert.doesNotMatch(source, /certificateThumbprint\s*=\s*\$certificateThumbprint/)
  assert.match(toolchainSource, /bundle-existing/)
  assert.match(toolchainSource, /@\('bundle', '--ci', '--bundles', 'nsis'\)/)
})

test('new user-visible jobs and diagnostics use AEONQUILL while legacy protocols remain readable', async () => {
  const [workflowBuilder, t2vTemplate, i2vTemplate, imageProcessor, projectStore, security, validator] = await Promise.all([
    readFile(join(projectRoot, 'server', 'workflow-builder.mjs'), 'utf8'),
    readFile(join(projectRoot, 'server', 'workflows', 'minimax-h3-t2v.json'), 'utf8'),
    readFile(join(projectRoot, 'server', 'workflows', 'minimax-h3-i2v.json'), 'utf8'),
    readFile(join(projectRoot, 'server', 'image-processor.mjs'), 'utf8'),
    readFile(join(projectRoot, 'server', 'project-store.mjs'), 'utf8'),
    readFile(join(projectRoot, 'server', 'security.mjs'), 'utf8'),
    readFile(join(projectRoot, 'scripts', 'validate.mjs'), 'utf8'),
  ])
  for (const source of [workflowBuilder, t2vTemplate, i2vTemplate]) {
    assert.doesNotMatch(source, /MiaoHui\/(?:T2V|I2V|H3_)/)
    assert.match(source, /AEONQUILL\//)
  }
  assert.match(imageProcessor, /AEONQUILL_REMBG_MODELS/)
  assert.doesNotMatch(imageProcessor, /请配置 MIAOHUI_REMBG_MODELS/)
  assert.match(projectStore, /valid AEONQUILL archive/)
  assert.match(security, /AEONQUILL local bridge/)
  assert.match(validator, /AEONQUILL \$\{profile\} validation/)
  assert.match(security, /miaohui_session/, 'Legacy session cookie remains a compatibility protocol')
})

test('Electron fallback package carries every server dependency that crosses into src', async () => {
  const packageSource = await readFile(join(projectRoot, 'scripts', 'package-electron.mjs'), 'utf8')
  for (const sharedModule of [
    'canvasCore.mjs',
    'pixelCore.mjs',
    'storyProject.mjs',
    'storyExecution.mjs',
    'productShellState.mjs',
  ]) {
    assert.match(packageSource, new RegExp(`['"]${sharedModule.replace('.', '\\.') }['"]`))
  }
})

test('release manifest contract is strict, path-safe and stage-only', async () => {
  const metadata = await loadReleaseMetadata(projectRoot)
  const hash = 'a'.repeat(64)
  const manifest = {
    schemaVersion: 2,
    product: {
      name: metadata.productName,
      displayName: metadata.displayName,
      packageName: metadata.packageName,
      version: metadata.version,
      identifier: metadata.identifier,
      identifierMigrationStatus: metadata.identifierMigrationStatus,
      channel: metadata.channel,
      distributionStatus: 'unsigned-test-package',
    },
    target: { platform: 'windows', arch: 'x64', format: 'nsis', installScope: 'currentUser' },
    source: { gitCommit: 'b'.repeat(40), workingTreeDirty: false },
    identity: {
      version: metadata.buildIdentityVersion,
      productVersion: metadata.version,
      functionalTrack: metadata.functionalTrack,
      sourceCommit: 'b'.repeat(40),
      runtimePackageId: null,
      runtimeRegistryVersion: metadata.runtimeRegistryVersion,
    },
    build: {
      generatedAt: '2026-08-15T00:00:00.000Z',
      nodeVersion: 'v22.18.0',
      tauriCliVersion: '2.8.1',
      electronFallbackVersion: '43.4.0',
      webview2Mode: 'offlineInstaller',
    },
    artifacts: [{
      role: 'windows-x64-nsis-installer',
      file: metadata.installerFilename,
      bytes: 11 * 1024 * 1024,
      sha256: hash,
      signature: { signed: false, valid: false, status: 'NotSigned', subject: null },
    }],
    components: {
      application: {
        file: metadata.appExecutable,
        bytes: 2_000_000,
        sha256: hash,
        signature: { signed: false, valid: false, status: 'NotSigned', subject: null },
      },
      sidecar: {
        file: metadata.sidecarRuntimeFilename,
        bytes: 30_000_000,
        sha256: hash,
        nodeMajor: 22,
        systemNodeRequired: false,
        parentControl: 'stdio',
        signature: { signed: false, valid: false, status: 'NotSigned', subject: null },
      },
    },
    externalDependencies: [],
    licensing: {
      status: 'stage-review-required',
      publicCommercialReleaseReady: false,
      noticeFile: 'THIRD-PARTY-NOTICES.md',
      limitationsFile: 'LIMITATIONS.zh-CN.md',
      unresolved: ['review'],
    },
    excluded: [],
    files: {
      installGuide: 'INSTALL.zh-CN.md',
      limitations: 'LIMITATIONS.zh-CN.md',
      notices: 'THIRD-PARTY-NOTICES.md',
      checksums: 'SHA256SUMS.txt',
      schema: 'release-manifest.schema.json',
    },
  }
  assert.equal(validateReleaseManifestShape(manifest, metadata), manifest)
  assert.throws(
    () => validateReleaseManifestShape({
      ...manifest,
      build: { ...manifest.build, nodeVersion: 'C:\\private\\node.exe' },
    }, metadata),
    /absolute filesystem path/,
  )
  assert.throws(
    () => validateReleaseManifestShape({ ...manifest, leakedField: true }, metadata),
    /manifest must contain exactly/,
  )
  assert.throws(
    () => validateReleaseManifestShape({
      ...manifest,
      components: {
        ...manifest.components,
        application: { ...manifest.components.application, leakedField: true },
      },
    }, metadata),
    /manifest\.components\.application must contain exactly/,
  )
})

test('stage package carries installation, limitation, notice and manifest-schema material', async () => {
  const files = [
    'INSTALL.zh-CN.md',
    'LIMITATIONS.zh-CN.md',
    'THIRD-PARTY-NOTICES.md',
    'release-manifest.schema.json',
  ]
  const sources = await Promise.all(files.map((file) => readFile(join(projectRoot, 'desktop', 'release', file), 'utf8')))
  assert.match(sources[0], /自签名阶段测试包/)
  assert.match(sources[1], /不能标注为正式商业发行版/)
  assert.match(sources[2], /not approved for public commercial release/)
  const schema = JSON.parse(sources[3])
  assert.equal(schema.properties.product.properties.name.const, 'AEONQUILL')
  assert.equal(schema.properties.product.properties.identifierMigrationStatus.const, 'legacy-preserved-for-data-continuity')
  assert.equal(schema.additionalProperties, false)
  assert.equal(schema.$defs.component.additionalProperties, false)
  assert.equal(schema.$defs.sidecarComponent.additionalProperties, false)
})

test('full offline installer binds the application and runtime before installation', async () => {
  const [installer, command] = await Promise.all([
    readFile(join(projectRoot, 'desktop', 'release', 'Install-AEONQUILL-Full.ps1'), 'utf8'),
    readFile(join(projectRoot, 'desktop', 'release', 'Install-AEONQUILL-Full.cmd'), 'utf8'),
  ])
  for (const requiredToken of [
    'offline-release-manifest.json',
    'SHA256SUMS-offline.txt',
    'aggregateSha256',
    'Test-BoundArtifact',
    'Test-CriticalFiles',
    'self-signed-local-test',
    'falling feather制作',
    'Get-AuthenticodeSignature',
    'AcceptMiniMaxH3License',
    'UsePayloadInPlace',
    'RepairRuntime',
    'InstallBase',
    'MigrateLegacyData',
    'RemoveLegacyAfterMigration',
    'ReplaceExistingApplication',
    'aeonquill-layout.json',
    'sibling-user-data',
  ]) assert.match(installer, new RegExp(requiredToken))
  assert.match(installer, /productVersion = '0\.6\.0'/)
  assert.match(installer, /RemoveLegacyAfterMigration -and \(Test-Path/)
  assert.match(installer, /Start-Process -FilePath \$installerPath/)
  assert.match(installer, /"\/D=\$applicationDirectory"/)
  assert.match(command, /-UsePayloadInPlace/)
  assert.match(command, /-MigrateLegacyData/)
  assert.match(command, /-ReplaceExistingApplication/)
  assert.doesNotMatch(installer, /Get-ChildItem[^\n]+AEONQUILL_\*/)
})
