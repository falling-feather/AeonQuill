import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { loadReleaseMetadata } from '../desktop/release/release-meta.mjs'
import { sha256File, validateReleaseManifestShape } from '../desktop/release/manifest-contract.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const metadata = await loadReleaseMetadata(projectRoot)
const packageRoot = join(projectRoot, '下载', `光阴砚AEONQUILL-${metadata.version}-Windows-x64-轻量按需版`)
const reportPath = join(projectRoot, '.runtime', 'qa', 'desktop-lightweight-release.json')
const expectedFiles = [
  metadata.installerFilename,
  'INSTALL.zh-CN.md',
  'LIMITATIONS.zh-CN.md',
  'THIRD-PARTY-NOTICES.md',
  'release-manifest.json',
  'release-manifest.schema.json',
  'SHA256SUMS.txt',
].sort((left, right) => left.localeCompare(right, 'en'))

function parseChecksums(source) {
  const entries = new Map()
  for (const line of source.trim().split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64})  ([^\\/]+)$/u.exec(line)
    assert.ok(match, `Invalid SHA256SUMS line: ${line}`)
    entries.set(match[2], match[1])
  }
  return entries
}

async function inspectSignature(pathname) {
  const escaped = basename(pathname).replaceAll("'", "''")
  const script = `$raw = [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile('${escaped}'); $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($raw); try { $subjectBytes = [System.Text.Encoding]::UTF8.GetBytes([string]$certificate.Subject); [pscustomobject]@{ Status = 'EmbeddedSignature'; SubjectBase64 = [System.Convert]::ToBase64String($subjectBytes); Thumbprint = [string]$certificate.Thumbprint } | ConvertTo-Json -Compress } finally { $certificate.Dispose(); $raw.Dispose() }`
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: dirname(pathname),
    windowsHide: true,
    encoding: 'utf8',
  })
  const result = JSON.parse(stdout.trim())
  return {
    ...result,
    Subject: Buffer.from(result.SubjectBase64, 'base64').toString('utf8'),
  }
}

const entries = await readdir(packageRoot, { withFileTypes: true })
assert.equal(entries.every((entry) => entry.isFile()), true, 'Lightweight package must not contain nested runtime directories')
assert.deepEqual(entries.map((entry) => entry.name).sort((left, right) => left.localeCompare(right, 'en')), expectedFiles)

const manifest = JSON.parse(await readFile(join(packageRoot, 'release-manifest.json'), 'utf8'))
validateReleaseManifestShape(manifest, metadata)
assert.equal(manifest.product.version, metadata.version)
assert.equal(manifest.product.distributionStatus, 'self-signed-test-package')
assert.equal(manifest.source.workingTreeDirty, false)
assert.equal(manifest.externalDependencies.some(({ name, bundled }) => name === 'ComfyUI' && bundled === false), true)
assert.equal(manifest.excluded.includes('ComfyUI-Python-custom-nodes-and-model-weights'), true)
for (const component of [manifest.artifacts[0].signature, manifest.components.application.signature, manifest.components.sidecar.signature]) {
  assert.equal(component.signed, true)
  assert.match(component.subject || '', /falling feather制作/u)
}

const checksums = parseChecksums(await readFile(join(packageRoot, 'SHA256SUMS.txt'), 'utf8'))
assert.equal(checksums.size, expectedFiles.length - 1)
for (const [filename, expected] of checksums) {
  assert.equal(await sha256File(join(packageRoot, filename)), expected, `Checksum mismatch: ${filename}`)
}

const installerPath = join(packageRoot, metadata.installerFilename)
const signature = await inspectSignature(installerPath)
assert.match(signature.Subject || '', /falling feather制作/u)
const sizes = await Promise.all(entries.map((entry) => stat(join(packageRoot, entry.name))))
const totalBytes = sizes.reduce((sum, entry) => sum + entry.size, 0)
assert.ok(totalBytes < 1024 * 1024 * 1024)
assert.match(await readFile(join(packageRoot, 'INSTALL.zh-CN.md'), 'utf8'), /工作流中心/u)
assert.match(await readFile(join(packageRoot, 'LIMITATIONS.zh-CN.md'), 'utf8'), /不包含 Python、ComfyUI/u)

await mkdir(dirname(reportPath), { recursive: true })
await writeFile(reportPath, `${JSON.stringify({
  schemaVersion: 1,
  status: 'passed',
  productVersion: metadata.version,
  sourceCommit: manifest.source.gitCommit,
  packageDirectory: packageRoot,
  files: expectedFiles.length,
  totalBytes,
  installer: {
    filename: metadata.installerFilename,
    bytes: (await stat(installerPath)).size,
    sha256: await sha256File(installerPath),
    signatureStatus: signature.Status,
    signatureSubject: signature.Subject,
  },
  runtimeBundled: false,
  validatedAt: new Date().toISOString(),
}, null, 2)}\n`, 'utf8')
console.log(`✓ Lightweight release ${metadata.version}: ${(totalBytes / 1024 / 1024).toFixed(1)} MiB`)
console.log(`✓ Installer self-signed by falling feather制作; 7/7 files and 6/6 checksums verified`)
console.log(`✓ Report: ${reportPath}`)
