import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadReleaseMetadata, resolveReleasePaths } from '../desktop/release/release-meta.mjs'
import { sha256File, validateReleaseManifestShape } from '../desktop/release/manifest-contract.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const metadata = await loadReleaseMetadata(projectRoot)
const releasePaths = resolveReleasePaths(metadata)
const downloadRoot = join(projectRoot, '下载')
const packageName = `光阴砚AEONQUILL-${metadata.version}-Windows-x64-轻量按需版`
const finalRoot = join(downloadRoot, packageName)
const reportPath = join(projectRoot, '.runtime', 'releases', 'lightweight', 'latest.json')

function assertDirectChild(root, target, label) {
  const relation = relative(resolve(root), resolve(target))
  assert.ok(relation && !relation.startsWith('..') && !isAbsolute(relation), `${label} must stay inside the download directory`)
  assert.equal(relation.includes('/') || relation.includes('\\'), false, `${label} must be a direct child of the download directory`)
}

function parseChecksums(source) {
  const entries = new Map()
  for (const line of source.trim().split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64})  ([^\\/]+)$/u.exec(line)
    assert.ok(match, `Invalid SHA256SUMS line: ${line}`)
    assert.equal(entries.has(match[2]), false, `Duplicate checksum entry: ${match[2]}`)
    entries.set(match[2], match[1])
  }
  return entries
}

async function verifyChecksums(root) {
  const checksums = parseChecksums(await readFile(join(root, 'SHA256SUMS.txt'), 'utf8'))
  for (const [filename, expected] of checksums) {
    assert.equal(await sha256File(join(root, filename)), expected, `Checksum mismatch: ${filename}`)
  }
  return checksums
}

await mkdir(downloadRoot, { recursive: true })
assertDirectChild(downloadRoot, finalRoot, 'lightweight package')

const sourceEntries = await readdir(releasePaths.stageDirectory, { withFileTypes: true })
assert.equal(sourceEntries.length, 7, 'Signed stage must contain exactly seven release files')
assert.equal(sourceEntries.every((entry) => entry.isFile()), true, 'Signed stage must not contain nested payload directories')

const sourceManifest = JSON.parse(await readFile(join(releasePaths.stageDirectory, 'release-manifest.json'), 'utf8'))
validateReleaseManifestShape(sourceManifest, metadata)
assert.equal(sourceManifest.source.workingTreeDirty, false, 'Lightweight package must come from a clean Git commit')
assert.equal(sourceManifest.product.version, metadata.version)
assert.equal(sourceManifest.product.distributionStatus, 'self-signed-test-package')
assert.equal(sourceManifest.externalDependencies.some(({ name, bundled }) => name === 'ComfyUI' && bundled === false), true)
assert.equal(sourceManifest.excluded.includes('ComfyUI-Python-custom-nodes-and-model-weights'), true)
assert.match(await readFile(join(releasePaths.stageDirectory, 'INSTALL.zh-CN.md'), 'utf8'), /不捆绑/u)
assert.match(await readFile(join(releasePaths.stageDirectory, 'LIMITATIONS.zh-CN.md'), 'utf8'), /轻量按需测试包/u)
await verifyChecksums(releasePaths.stageDirectory)

const temporaryRoot = await mkdtemp(join(downloadRoot, `.aeonquill-${metadata.version}-lightweight-`))
assertDirectChild(downloadRoot, temporaryRoot, 'temporary lightweight package')
let promoted = false
try {
  for (const entry of sourceEntries) {
    await cp(join(releasePaths.stageDirectory, entry.name), join(temporaryRoot, entry.name))
  }
  const checksums = await verifyChecksums(temporaryRoot)
  const copiedEntries = await readdir(temporaryRoot, { withFileTypes: true })
  assert.equal(copiedEntries.length, 7)
  assert.equal(copiedEntries.every((entry) => entry.isFile()), true)
  const sizes = await Promise.all(copiedEntries.map((entry) => stat(join(temporaryRoot, entry.name))))
  const totalBytes = sizes.reduce((sum, entry) => sum + entry.size, 0)
  assert.ok(totalBytes > 10 * 1024 * 1024, 'Lightweight package is unexpectedly small')
  assert.ok(totalBytes < 1024 * 1024 * 1024, 'Lightweight package must remain below 1 GiB')

  await rm(finalRoot, { recursive: true, force: true })
  await rename(temporaryRoot, finalRoot)
  promoted = true

  await mkdir(join(projectRoot, '.runtime', 'releases', 'lightweight'), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify({
    schemaVersion: 1,
    status: 'staged',
    productVersion: metadata.version,
    packageName,
    sourceCommit: sourceManifest.source.gitCommit,
    files: copiedEntries.map((entry) => entry.name).sort((left, right) => left.localeCompare(right, 'en')),
    checksummedFiles: checksums.size,
    totalBytes,
    installerSha256: sourceManifest.artifacts[0].sha256,
    runtimeBundled: false,
    stagedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8')
  console.log(`✓ Lightweight package staged: ${finalRoot}`)
  console.log(`✓ ${(totalBytes / 1024 / 1024).toFixed(1)} MiB; no ComfyUI, Python, models, projects or user output bundled`)
} finally {
  if (!promoted) await rm(temporaryRoot, { recursive: true, force: true })
}
