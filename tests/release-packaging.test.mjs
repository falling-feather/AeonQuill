import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadReleaseMetadata, resolveReleasePaths } from '../desktop/release/release-meta.mjs'
import { validateReleaseManifestShape } from '../desktop/release/manifest-contract.mjs'
import {
  DURABLE_USER_DATA_MARKERS,
  selectElectronUserDataDirectory,
} from '../desktop/shared/user-data-compat.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))

test('desktop release identity and version mirrors resolve from package.json', async () => {
  const metadata = await loadReleaseMetadata(projectRoot)
  const paths = resolveReleasePaths(metadata)
  const [tauriConfig, cargoSource, mainSource, tauriSource, electronSource] = await Promise.all([
    readFile(join(projectRoot, 'desktop', 'tauri', 'src-tauri', 'tauri.conf.json'), 'utf8').then(JSON.parse),
    readFile(join(projectRoot, 'desktop', 'tauri', 'src-tauri', 'Cargo.toml'), 'utf8'),
    readFile(join(projectRoot, 'desktop', 'tauri', 'src-tauri', 'src', 'main.rs'), 'utf8'),
    readFile(join(projectRoot, 'desktop', 'tauri', 'src-tauri', 'src', 'lib.rs'), 'utf8'),
    readFile(join(projectRoot, 'desktop', 'electron', 'main.mjs'), 'utf8'),
  ])

  assert.equal(metadata.productName, 'AEONQUILL')
  assert.equal(metadata.displayName, '光阴砚 AEONQUILL')
  assert.equal(metadata.version, '0.3.0')
  assert.equal(metadata.identifier, 'com.miaohui.desktop')
  assert.equal(metadata.identifierMigrationStatus, 'legacy-preserved-for-data-continuity')
  assert.equal(tauriConfig.version, '../../../package.json')
  assert.deepEqual(tauriConfig.bundle.resources, {
    '../../release/INSTALL.zh-CN.md': 'release/INSTALL.zh-CN.md',
    '../../release/LIMITATIONS.zh-CN.md': 'release/LIMITATIONS.zh-CN.md',
    '../../release/THIRD-PARTY-NOTICES.md': 'release/THIRD-PARTY-NOTICES.md',
  })
  assert.match(cargoSource, /^name = "aeonquill-desktop"$/m)
  assert.match(cargoSource, /^version = "0\.3\.0"$/m)
  assert.match(mainSource, /aeonquill_desktop_lib::run\(\)/)
  assert.match(tauriSource, /\.sidecar\("aeonquill-bridge"\)/)
  assert.match(tauriSource, /\.title\("光阴砚 AEONQUILL"\)/)
  for (const key of [
    'AEONQUILL_RUNTIME_DIR',
    'AEONQUILL_DATA_DIR',
    'AEONQUILL_CACHE_DIR',
    'AEONQUILL_LOG_DIR',
    'AEONQUILL_CONFIG',
  ]) {
    assert.match(tauriSource, new RegExp(key))
    assert.match(electronSource, new RegExp(key))
  }
  assert.equal(basename(paths.installer), 'AEONQUILL_0.3.0_x64-setup.exe')
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
      storagePathsExplicit: true,
      pathExists,
    }),
    { directory: current, layout: 'aeonquill-explicit-storage' },
  )
})

test('packaging scripts contain no legacy MiaoHui artifact identities', async () => {
  const files = [
    'scripts/build-node-sidecar.mjs',
    'scripts/package-electron.mjs',
    'scripts/validate-desktop-electron.mjs',
    'scripts/validate-desktop-tauri.mjs',
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
    schemaVersion: 1,
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
    build: {
      generatedAt: '2026-08-15T00:00:00.000Z',
      nodeVersion: 'v22.18.0',
      tauriCliVersion: '2.8.1',
      electronFallbackVersion: '43.4.0',
      webview2Mode: 'embedBootstrapper',
    },
    artifacts: [{
      role: 'windows-x64-nsis-installer',
      file: metadata.installerFilename,
      bytes: 11 * 1024 * 1024,
      sha256: hash,
      signature: { signed: false, valid: false, status: 'NotSigned', subject: null },
    }],
    components: {
      application: { file: metadata.appExecutable, bytes: 2_000_000, sha256: hash },
      sidecar: {
        file: metadata.sidecarRuntimeFilename,
        bytes: 30_000_000,
        sha256: hash,
        nodeMajor: 22,
        systemNodeRequired: false,
        parentControl: 'stdio',
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
  assert.match(sources[0], /未签名阶段测试包/)
  assert.match(sources[1], /不能标注为正式商业发行版/)
  assert.match(sources[2], /not approved for public commercial release/)
  const schema = JSON.parse(sources[3])
  assert.equal(schema.properties.product.properties.name.const, 'AEONQUILL')
  assert.equal(schema.properties.product.properties.identifierMigrationStatus.const, 'legacy-preserved-for-data-continuity')
  assert.equal(schema.additionalProperties, false)
  assert.equal(schema.$defs.component.additionalProperties, false)
  assert.equal(schema.$defs.sidecarComponent.additionalProperties, false)
})
