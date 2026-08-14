import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const COMMIT_PATTERN = /^[a-f0-9]{40}$/
const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/

function assertExactKeys(value, keys, location) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${location} must be an object`)
  const expected = [...keys].sort()
  const actual = Object.keys(value).sort()
  assert.deepEqual(actual, expected, `${location} must contain exactly: ${expected.join(', ')}`)
}

export async function sha256File(pathname) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(pathname)) hash.update(chunk)
  return hash.digest('hex')
}

function assertNoAbsolutePaths(value, location = 'manifest') {
  if (typeof value === 'string') {
    assert.equal(
      ABSOLUTE_PATH_PATTERN.test(value),
      false,
      `${location} must not expose an absolute filesystem path`,
    )
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoAbsolutePaths(entry, `${location}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) {
    assertNoAbsolutePaths(entry, `${location}.${key}`)
  }
}

export function validateReleaseManifestShape(manifest, metadata) {
  assertExactKeys(manifest, [
    'schemaVersion',
    'product',
    'target',
    'source',
    'build',
    'artifacts',
    'components',
    'externalDependencies',
    'licensing',
    'excluded',
    'files',
  ], 'manifest')
  assert.equal(manifest.schemaVersion, 1)
  assert.deepEqual(manifest.product, {
    name: metadata.productName,
    displayName: metadata.displayName,
    packageName: metadata.packageName,
    version: metadata.version,
    identifier: metadata.identifier,
    identifierMigrationStatus: metadata.identifierMigrationStatus,
    channel: metadata.channel,
    distributionStatus: 'unsigned-test-package',
  })
  assert.deepEqual(manifest.target, {
    platform: metadata.platform,
    arch: metadata.arch,
    format: 'nsis',
    installScope: metadata.installMode,
  })
  assertExactKeys(manifest.source, ['gitCommit', 'workingTreeDirty'], 'manifest.source')
  assert.match(manifest.source.gitCommit, COMMIT_PATTERN)
  assert.equal(typeof manifest.source.workingTreeDirty, 'boolean')
  assertExactKeys(manifest.build, [
    'generatedAt',
    'nodeVersion',
    'tauriCliVersion',
    'electronFallbackVersion',
    'webview2Mode',
  ], 'manifest.build')
  assert.match(manifest.build.generatedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(manifest.build.webview2Mode, metadata.webview2Mode)
  assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length === 1)
  const installer = manifest.artifacts[0]
  assertExactKeys(installer, ['role', 'file', 'bytes', 'sha256', 'signature'], 'manifest.artifacts[0]')
  assert.equal(installer.role, 'windows-x64-nsis-installer')
  assert.equal(installer.file, metadata.installerFilename)
  assert.ok(Number.isSafeInteger(installer.bytes) && installer.bytes > 10 * 1024 * 1024)
  assert.match(installer.sha256, SHA256_PATTERN)
  assertExactKeys(installer.signature, ['signed', 'valid', 'status', 'subject'], 'manifest.artifacts[0].signature')
  assert.equal(typeof installer.signature.signed, 'boolean')
  assert.equal(typeof installer.signature.valid, 'boolean')
  assert.equal(typeof installer.signature.status, 'string')
  assertExactKeys(manifest.components, ['application', 'sidecar'], 'manifest.components')
  assertExactKeys(manifest.components.application, ['file', 'bytes', 'sha256'], 'manifest.components.application')
  assertExactKeys(
    manifest.components.sidecar,
    ['file', 'bytes', 'sha256', 'nodeMajor', 'systemNodeRequired', 'parentControl'],
    'manifest.components.sidecar',
  )
  assert.equal(manifest.components.application.file, metadata.appExecutable)
  assert.equal(manifest.components.sidecar.file, metadata.sidecarRuntimeFilename)
  assert.equal(manifest.components.sidecar.systemNodeRequired, false)
  assert.match(manifest.components.application.sha256, SHA256_PATTERN)
  assert.match(manifest.components.sidecar.sha256, SHA256_PATTERN)
  assertExactKeys(
    manifest.files,
    ['installGuide', 'limitations', 'notices', 'schema', 'checksums'],
    'manifest.files',
  )
  assert.equal(manifest.files.checksums, 'SHA256SUMS.txt')
  assert.equal(manifest.files.schema, 'release-manifest.schema.json')
  assert.ok(Array.isArray(manifest.externalDependencies))
  manifest.externalDependencies.forEach((dependency, index) => {
    assertExactKeys(dependency, ['name', 'bundled', 'required', 'discovery'], `manifest.externalDependencies[${index}]`)
  })
  assert.ok(Array.isArray(manifest.excluded))
  assertExactKeys(
    manifest.licensing,
    ['status', 'publicCommercialReleaseReady', 'noticeFile', 'limitationsFile', 'unresolved'],
    'manifest.licensing',
  )
  assert.equal(manifest.licensing.publicCommercialReleaseReady, false)
  assertNoAbsolutePaths(manifest)
  return manifest
}
