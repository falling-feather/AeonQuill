import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { opendir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { loadReleaseMetadata } from '../desktop/release/release-meta.mjs'
import { OFFLINE_RUNTIME_PACKAGE_ID } from '../server/offline-runtime.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const metadata = await loadReleaseMetadata(projectRoot)
const downloadRoot = resolve(projectRoot, '下载')
const packageRoot = join(downloadRoot, `光阴砚AEONQUILL-${metadata.version}-Windows-x64-开箱即用版`)
const runtimeRoot = join(packageRoot, 'runtime', OFFLINE_RUNTIME_PACKAGE_ID)
const forbiddenFragments = [
  'D:\\AEONQUILL-Package',
  'D:/AEONQUILL-Package',
  resolve(projectRoot),
  portablePath(resolve(projectRoot)),
  'C:\\Users\\niu-h',
  'C:/Users/niu-h',
]
const inspectableExtension = /\.(?:cfg|ini|json|md|pth|ps1|txt|ya?ml)$/i

function portablePath(pathname) {
  return pathname.replaceAll('\\', '/')
}

function assertInside(root, target) {
  const relation = relative(resolve(root), resolve(target))
  assert.ok(relation && !relation.startsWith('..') && !isAbsolute(relation), `Path escaped package root: ${target}`)
}

const requiredRootEntries = new Set([
  metadata.installerFilename,
  'INSTALL.zh-CN.md',
  'LIMITATIONS.zh-CN.md',
  'THIRD-PARTY-NOTICES.md',
  'release-manifest.schema.json',
  'release-manifest.json',
  'SHA256SUMS.txt',
  'Install-AEONQUILL-Full.ps1',
  'Install-AEONQUILL-Full.cmd',
  'OFFLINE-FULL-INSTALL.zh-CN.md',
  'offline-release-manifest.json',
  'SHA256SUMS-offline.txt',
  'runtime',
])

const rootHandle = await opendir(packageRoot)
const rootEntries = []
for await (const entry of rootHandle) rootEntries.push(entry.name)
assert.deepEqual(new Set(rootEntries), requiredRootEntries, 'Turnkey root contains missing or unexpected files')

const forbiddenNames = new Set([
  '.git',
  '.github',
  'pyvenv.cfg',
  'extra_model_paths.yaml',
  'UserData',
  'projects',
  'client-state',
  'jobs.json',
  'job-archive.json',
])
let files = 0
let inspectedTextFiles = 0
async function visit(directory) {
  assertInside(packageRoot, directory)
  const handle = await opendir(directory)
  for await (const entry of handle) {
    assert.equal(forbiddenNames.has(entry.name), false, `Forbidden package entry: ${entry.name}`)
    const pathname = join(directory, entry.name)
    if (entry.isDirectory()) {
      await visit(pathname)
      continue
    }
    assert.equal(entry.isFile(), true, `Turnkey package cannot contain links: ${pathname}`)
    files += 1
    const fileStats = await stat(pathname)
    if (!inspectableExtension.test(entry.name) || fileStats.size > 2 * 1024 * 1024) continue
    inspectedTextFiles += 1
    const source = await readFile(pathname, 'utf8')
    for (const fragment of forbiddenFragments) {
      assert.equal(source.includes(fragment), false, `Source-machine path leaked into ${relative(packageRoot, pathname)}`)
    }
  }
}
await visit(runtimeRoot)

for (const directory of ['input', 'output', 'temp']) {
  const target = join(runtimeRoot, 'ComfyUI', directory)
  const handle = await opendir(target)
  const entries = []
  for await (const entry of handle) entries.push(entry.name)
  assert.deepEqual(entries, [], `Bundled ComfyUI ${directory} must be empty`)
}

const manifest = JSON.parse(await readFile(join(packageRoot, 'offline-release-manifest.json'), 'utf8'))
assert.equal(manifest.creator, 'falling feather制作')
assert.equal(manifest.runtime.packageId, OFFLINE_RUNTIME_PACKAGE_ID)
assert.equal(manifest.signing.privateKeyIncluded, false)

const escapedInstaller = join(packageRoot, metadata.installerFilename).replaceAll("'", "''")
const systemRoot = process.env.SystemRoot || 'C:\\Windows'
const { stdout } = await execFileAsync('powershell.exe', [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  `$utf8=New-Object Text.UTF8Encoding($false);[Console]::OutputEncoding=$utf8;$s=Get-AuthenticodeSignature -LiteralPath '${escapedInstaller}'; [pscustomobject]@{Subject=if($s.SignerCertificate){$s.SignerCertificate.Subject}else{$null};Status=[string]$s.Status}|ConvertTo-Json -Compress`,
], {
  windowsHide: true,
  encoding: 'utf8',
  env: {
    ...process.env,
    PSModulePath: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
  },
})
const signature = JSON.parse(stdout.trim())
assert.match(signature.Subject || '', /falling feather制作/u)

console.log(`✓ Turnkey boundary: ${files} runtime files, ${inspectedTextFiles} text/config files inspected`)
console.log(`✓ No project, user-data, source-machine path, venv pointer or signing private key is bundled`)
console.log(`✓ Installer signer ${signature.Subject}; trust status ${signature.Status}`)
