import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadReleaseMetadata } from '../desktop/release/release-meta.mjs'
import { OFFLINE_RUNTIME_PACKAGE_ID, probeOfflineRuntimePackage, sha256File } from '../server/offline-runtime.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const metadata = await loadReleaseMetadata(projectRoot)
const fullRoot = join(
  projectRoot,
  '下载',
  `光阴砚AEONQUILL-${metadata.version}-Windows-x64-开箱即用版`,
)
const manifest = JSON.parse(await readFile(join(fullRoot, 'offline-release-manifest.json'), 'utf8'))
assert.equal(manifest.schemaVersion, 1)
assert.deepEqual(manifest.product, { name: 'AEONQUILL', version: metadata.version })
assert.equal(manifest.distributionStatus, 'self-signed-local-test')
assert.equal(manifest.creator, 'falling feather制作')
assert.equal(manifest.signing.type, 'self-signed-authenticode')
assert.match(manifest.signing.subject, /falling feather制作/u)
assert.equal(manifest.signing.trustedByWindows, false)
assert.equal(typeof manifest.signing.buildMachineStatus, 'string')
assert.equal(manifest.signing.privateKeyIncluded, false)
assert.equal(manifest.licensing.publicCommercialReleaseReady, false)
assert.equal(manifest.install.systemNodeRequired, false)
assert.equal(manifest.install.systemPythonRequired, false)
assert.equal(manifest.install.externalNvidiaDriverRequired, true)

const lines = []
for (const entry of manifest.artifacts) {
  assert.equal(typeof entry.path, 'string')
  assert.equal(entry.path.includes('..'), false)
  const pathname = join(fullRoot, ...entry.path.split('/'))
  const fileStats = await stat(pathname)
  assert.equal(fileStats.isFile(), true)
  assert.equal(fileStats.size, entry.bytes)
  assert.equal(await sha256File(pathname), entry.sha256)
  lines.push(`${entry.sha256}  ${entry.path}`)
}
const aggregate = `${lines.join('\n')}\n`
assert.equal(createHash('sha256').update(aggregate).digest('hex'), manifest.aggregateSha256)
assert.equal(await readFile(join(fullRoot, 'SHA256SUMS-offline.txt'), 'utf8'), aggregate)

const runtime = await probeOfflineRuntimePackage({
  packageRoot: join(fullRoot, 'runtime', OFFLINE_RUNTIME_PACKAGE_ID),
  verifyCriticalHashes: true,
})
assert.ok(runtime)
assert.equal(runtime.manifest.inventory.treeSha256, manifest.runtime.treeSha256)
assert.equal(runtime.manifest.inventory.files, manifest.runtime.files)
assert.equal(runtime.manifest.inventory.bytes, manifest.runtime.bytes)

console.log(`✓ Full offline release ${metadata.version}`)
console.log(`✓ ${manifest.artifacts.length} bound artifacts and runtime critical hashes valid`)
console.log('✓ No system Node/Python contract; external NVIDIA driver remains explicit')
