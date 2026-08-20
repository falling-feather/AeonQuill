import assert from 'node:assert/strict'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { loadReleaseMetadata, resolveReleasePaths } from '../desktop/release/release-meta.mjs'
import {
  OFFLINE_RUNTIME_PACKAGE_ID,
  probeOfflineRuntimePackage,
  sha256File,
} from '../server/offline-runtime.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const metadata = await loadReleaseMetadata(projectRoot)
const releasePaths = resolveReleasePaths(metadata)
const runtimeRoot = resolve(projectRoot, '.runtime')
const fullRoot = join(
  runtimeRoot,
  'releases',
  'offline',
  `AEONQUILL_${metadata.version}_windows_x64_full`,
)
const runtimePackageRoot = join(fullRoot, 'runtime', OFFLINE_RUNTIME_PACKAGE_ID)
const sourceReleaseRoot = join(projectRoot, 'desktop', 'release')

function assertRuntimeTarget(target) {
  const relation = relative(runtimeRoot, resolve(target))
  assert.ok(relation && !relation.startsWith('..') && !isAbsolute(relation), `Unsafe offline release target: ${target}`)
}

assertRuntimeTarget(fullRoot)
await mkdir(fullRoot, { recursive: true })
const runtime = await probeOfflineRuntimePackage({ packageRoot: runtimePackageRoot, verifyCriticalHashes: true })
assert.ok(runtime, 'Validated offline runtime payload is missing; run npm run stage:desktop:runtime first')
assert.equal(runtime.productVersion, metadata.version)

const appManifestPath = join(releasePaths.stageDirectory, 'release-manifest.json')
const appManifest = JSON.parse(await readFile(appManifestPath, 'utf8'))
assert.equal(appManifest.product.version, metadata.version)
assert.equal(appManifest.source.workingTreeDirty, false, 'Full offline release requires a clean application candidate')

const stagedAppFiles = await readdir(releasePaths.stageDirectory, { withFileTypes: true })
for (const entry of stagedAppFiles) {
  if (!entry.isFile()) continue
  await cp(join(releasePaths.stageDirectory, entry.name), join(fullRoot, entry.name))
}
for (const filename of [
  'Install-AEONQUILL-Full.ps1',
  'Install-AEONQUILL-Full.cmd',
  'OFFLINE-FULL-INSTALL.zh-CN.md',
]) await cp(join(sourceReleaseRoot, filename), join(fullRoot, filename))

const boundFiles = [
  metadata.installerFilename,
  'release-manifest.json',
  'Install-AEONQUILL-Full.ps1',
  'Install-AEONQUILL-Full.cmd',
  'OFFLINE-FULL-INSTALL.zh-CN.md',
  `runtime/${OFFLINE_RUNTIME_PACKAGE_ID}/runtime-manifest.json`,
  `runtime/${OFFLINE_RUNTIME_PACKAGE_ID}/runtime-SHA256SUMS.txt`,
]
const artifacts = []
for (const relativePath of boundFiles) {
  const pathname = join(fullRoot, ...relativePath.split('/'))
  const fileStats = await stat(pathname)
  artifacts.push({ path: relativePath, bytes: fileStats.size, sha256: await sha256File(pathname) })
}
const aggregate = artifacts.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n') + '\n'
const manifest = {
  schemaVersion: 1,
  product: { name: 'AEONQUILL', version: metadata.version },
  target: { platform: 'windows', architecture: 'x64', format: 'split-offline-bundle' },
  distributionStatus: 'unsigned-local-stage-only',
  app: {
    installer: metadata.installerFilename,
    releaseManifest: 'release-manifest.json',
    sourceCommit: appManifest.source.gitCommit,
  },
  runtime: {
    packageId: runtime.packageId,
    manifest: `runtime/${OFFLINE_RUNTIME_PACKAGE_ID}/runtime-manifest.json`,
    inventory: `runtime/${OFFLINE_RUNTIME_PACKAGE_ID}/runtime-SHA256SUMS.txt`,
    files: runtime.manifest.inventory.files,
    bytes: runtime.manifest.inventory.bytes,
    treeSha256: runtime.manifest.inventory.treeSha256,
  },
  install: {
    entrypoint: 'Install-AEONQUILL-Full.cmd',
    powershell: 'Install-AEONQUILL-Full.ps1',
    systemNodeRequired: false,
    systemPythonRequired: false,
    externalNvidiaDriverRequired: true,
  },
  licensing: {
    publicCommercialReleaseReady: false,
    miniMaxH3TermsAcceptanceRequired: true,
    excludedTerritories: ['European Union', 'United Kingdom', 'Republic of Korea', 'United States of America'],
  },
  artifacts,
  aggregateSha256: createHash('sha256').update(aggregate).digest('hex'),
}
await writeFile(join(fullRoot, 'offline-release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
await writeFile(join(fullRoot, 'SHA256SUMS-offline.txt'), aggregate, 'utf8')

console.log(`✓ Full offline release: ${fullRoot}`)
console.log(`✓ App ${metadata.version} + ${(runtime.manifest.inventory.bytes / 1024 ** 3).toFixed(2)} GiB runtime`)
console.log(`✓ Bound artifact aggregate ${manifest.aggregateSha256}`)
