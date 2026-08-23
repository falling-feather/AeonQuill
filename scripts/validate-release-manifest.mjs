import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadReleaseMetadata, resolveReleasePaths } from '../desktop/release/release-meta.mjs'
import { sha256File, validateReleaseManifestShape } from '../desktop/release/manifest-contract.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const metadata = await loadReleaseMetadata(projectRoot)
const paths = resolveReleasePaths(metadata)
const manifestPath = join(paths.stageDirectory, 'release-manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
validateReleaseManifestShape(manifest, metadata)

for (const artifact of manifest.artifacts) {
  const pathname = join(paths.stageDirectory, artifact.file)
  const artifactStats = await stat(pathname)
  assert.equal(artifactStats.size, artifact.bytes, `${artifact.file} byte size changed after staging`)
  assert.equal(await sha256File(pathname), artifact.sha256, `${artifact.file} SHA-256 mismatch`)
}

const checksumSource = await readFile(join(paths.stageDirectory, manifest.files.checksums), 'utf8')
const checksumLines = checksumSource.trim().split(/\r?\n/).filter(Boolean)
assert.ok(checksumLines.length >= 6, 'Release checksum list is incomplete')
for (const line of checksumLines) {
  const match = line.match(/^([a-f0-9]{64}) {2}([^\\/]+)$/)
  assert.ok(match, `Malformed checksum line: ${line}`)
  const [, expectedHash, filename] = match
  assert.equal(await sha256File(join(paths.stageDirectory, filename)), expectedHash, `${filename} checksum mismatch`)
}

if (process.argv.includes('--require-clean')) {
  assert.equal(manifest.source.workingTreeDirty, false, 'Release candidate was staged from a dirty worktree')
}
const signatures = [
  manifest.artifacts[0].signature,
  manifest.components.application.signature,
  manifest.components.sidecar.signature,
]
if (manifest.product.distributionStatus === 'self-signed-test-package') {
  for (const signature of signatures) {
    assert.equal(signature.signed, true)
    assert.match(signature.subject || '', /falling feather制作/u)
  }
} else {
  for (const signature of signatures) assert.equal(signature.signed, false)
}
assert.equal(manifest.licensing.publicCommercialReleaseReady, false)

console.log(`✓ Release manifest v${manifest.schemaVersion}: ${metadata.productName} ${metadata.version}`)
console.log(`✓ ${checksumLines.length} staged files match SHA-256 records`)
console.log(`✓ Signature ${manifest.product.distributionStatus} (${manifest.artifacts[0].signature.status}); commercial-ready=false`)
