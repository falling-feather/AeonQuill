import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export const RELEASE_CHANNEL = 'stage'
export const TARGET_PLATFORM = 'windows'
export const TARGET_ARCH = 'x64'
export const RUST_TARGET = 'x86_64-pc-windows-msvc'
export const DISPLAY_NAME = '光阴砚 AEONQUILL'

function parseCargoPackageName(cargoSource) {
  const marker = '[package]'
  const packageStart = cargoSource.indexOf(marker)
  assert.ok(packageStart >= 0, 'Cargo package section is missing')
  const packageTail = cargoSource.slice(packageStart + marker.length)
  const nextSection = packageTail.search(/^\[/m)
  const packageSection = nextSection >= 0 ? packageTail.slice(0, nextSection) : packageTail
  const name = packageSection.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1]
  const version = packageSection.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1]
  assert.ok(name, 'Cargo package name is missing')
  assert.ok(version, 'Cargo package version is missing')
  return { name, version }
}

export async function loadReleaseMetadata(projectRoot) {
  const root = resolve(projectRoot)
  const packagePath = join(root, 'package.json')
  const tauriRoot = join(root, 'desktop', 'tauri', 'src-tauri')
  const tauriConfigPath = join(tauriRoot, 'tauri.conf.json')
  const cargoPath = join(tauriRoot, 'Cargo.toml')
  const [packageJson, tauriConfig, cargoSource, packageLock] = await Promise.all([
    readFile(packagePath, 'utf8').then(JSON.parse),
    readFile(tauriConfigPath, 'utf8').then(JSON.parse),
    readFile(cargoPath, 'utf8'),
    readFile(join(root, 'package-lock.json'), 'utf8').then(JSON.parse),
  ])
  const versionSourcePath = resolve(dirname(tauriConfigPath), tauriConfig.version)
  assert.equal(versionSourcePath, packagePath, 'Tauri must read its version from the root package.json')
  assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  assert.equal(tauriConfig.productName, 'AEONQUILL')
  // Keep the invisible legacy identifier until a dedicated, tested data migration exists.
  assert.equal(tauriConfig.identifier, 'com.miaohui.desktop')
  assert.equal(packageJson.name, 'aeonquill')

  const cargo = parseCargoPackageName(cargoSource)
  assert.equal(cargo.version, packageJson.version, 'Cargo version must mirror package.json')
  assert.equal(cargo.name, 'aeonquill-desktop')
  const externalBin = tauriConfig.bundle?.externalBin?.[0]
  assert.equal(externalBin, 'binaries/aeonquill-bridge')

  const productName = tauriConfig.productName
  const version = packageJson.version
  const appExecutable = `${cargo.name}.exe`
  const sidecarBaseName = basename(externalBin)
  const sidecarBuildFilename = `${sidecarBaseName}-${RUST_TARGET}.exe`
  const sidecarRuntimeFilename = `${sidecarBaseName}.exe`
  const installerFilename = `${productName}_${version}_${TARGET_ARCH}-setup.exe`
  const electronDirectoryName = `${productName}-win32-${TARGET_ARCH}`
  const electronExecutable = `${productName}.exe`
  const stageDirectoryName = `${productName}_${version}_${TARGET_PLATFORM}_${TARGET_ARCH}_${RELEASE_CHANNEL}`
  const lockPackages = packageLock.packages || {}

  return Object.freeze({
    projectRoot: root,
    packageName: packageJson.name,
    productName,
    displayName: DISPLAY_NAME,
    version,
    identifier: tauriConfig.identifier,
    identifierMigrationStatus: 'legacy-preserved-for-data-continuity',
    channel: RELEASE_CHANNEL,
    platform: TARGET_PLATFORM,
    arch: TARGET_ARCH,
    rustTarget: RUST_TARGET,
    appExecutable,
    sidecarBaseName,
    sidecarBuildFilename,
    sidecarRuntimeFilename,
    installerFilename,
    electronDirectoryName,
    electronExecutable,
    stageDirectoryName,
    webview2Mode: tauriConfig.bundle?.windows?.webviewInstallMode?.type,
    installMode: tauriConfig.bundle?.windows?.nsis?.installMode,
    tauriCliVersion: lockPackages['node_modules/@tauri-apps/cli']?.version || null,
    electronVersion: lockPackages['node_modules/electron']?.version || null,
  })
}

export function resolveReleasePaths(metadata) {
  const tauriRoot = join(metadata.projectRoot, 'desktop', 'tauri', 'src-tauri')
  const targetReleaseRoot = join(tauriRoot, 'target', 'release')
  const stagingRoot = join(metadata.projectRoot, '.runtime', 'releases', 'staging')
  return Object.freeze({
    tauriRoot,
    targetReleaseRoot,
    sourceSidecar: join(tauriRoot, 'binaries', metadata.sidecarBuildFilename),
    builtApp: join(targetReleaseRoot, metadata.appExecutable),
    bundledSidecar: join(targetReleaseRoot, metadata.sidecarRuntimeFilename),
    installer: join(targetReleaseRoot, 'bundle', 'nsis', metadata.installerFilename),
    electronReleaseRoot: join(metadata.projectRoot, '.runtime', 'releases', 'electron'),
    electronDirectory: join(
      metadata.projectRoot,
      '.runtime',
      'releases',
      'electron',
      metadata.electronDirectoryName,
    ),
    electronExecutable: join(
      metadata.projectRoot,
      '.runtime',
      'releases',
      'electron',
      metadata.electronDirectoryName,
      metadata.electronExecutable,
    ),
    stagingRoot,
    stageDirectory: join(stagingRoot, metadata.stageDirectoryName),
  })
}
