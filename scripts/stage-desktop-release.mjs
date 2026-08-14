import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { loadReleaseMetadata, resolveReleasePaths } from '../desktop/release/release-meta.mjs'
import { sha256File, validateReleaseManifestShape } from '../desktop/release/manifest-contract.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const metadata = await loadReleaseMetadata(projectRoot)
const paths = resolveReleasePaths(metadata)
const releaseSourceRoot = join(projectRoot, 'desktop', 'release')

function assertRuntimeTarget(target) {
  const runtimeRoot = resolve(projectRoot, '.runtime')
  const relativePath = relative(runtimeRoot, resolve(target))
  assert.ok(relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath), `Unsafe release target: ${target}`)
}

async function gitOutput(args) {
  const { stdout } = await execFileAsync('git.exe', args, {
    cwd: projectRoot,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  })
  return stdout.trim()
}

async function inspectAuthenticodeSignature(pathname) {
  if (process.platform !== 'win32') {
    return { signed: false, valid: false, status: 'unsupported-platform', subject: null }
  }
  const escapedPath = pathname.replaceAll("'", "''")
  const script = [
    `$signature = Get-AuthenticodeSignature -LiteralPath '${escapedPath}';`,
    '[pscustomobject]@{',
    'Status = [string]$signature.Status;',
    'Subject = if ($null -eq $signature.SignerCertificate) { $null } else { [string]$signature.SignerCertificate.Subject }',
    '} | ConvertTo-Json -Compress',
  ].join(' ')
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    cwd: projectRoot,
    windowsHide: true,
    encoding: 'utf8',
  })
  const parsed = JSON.parse(stdout.trim())
  const subject = parsed.Subject || null
  return {
    signed: Boolean(subject),
    valid: parsed.Status === 'Valid',
    status: String(parsed.Status || 'Unknown'),
    subject,
  }
}

for (const artifactPath of [paths.installer, paths.builtApp, paths.bundledSidecar]) {
  const artifactStats = await stat(artifactPath)
  assert.ok(artifactStats.isFile(), `Release artifact is missing: ${artifactPath}`)
}

assertRuntimeTarget(paths.stageDirectory)
await rm(paths.stageDirectory, { recursive: true, force: true })
await mkdir(paths.stageDirectory, { recursive: true })

const stagedFiles = {
  installer: metadata.installerFilename,
  installGuide: 'INSTALL.zh-CN.md',
  limitations: 'LIMITATIONS.zh-CN.md',
  notices: 'THIRD-PARTY-NOTICES.md',
  schema: 'release-manifest.schema.json',
  manifest: 'release-manifest.json',
  checksums: 'SHA256SUMS.txt',
}
await Promise.all([
  cp(paths.installer, join(paths.stageDirectory, stagedFiles.installer)),
  cp(join(releaseSourceRoot, stagedFiles.installGuide), join(paths.stageDirectory, stagedFiles.installGuide)),
  cp(join(releaseSourceRoot, stagedFiles.limitations), join(paths.stageDirectory, stagedFiles.limitations)),
  cp(join(releaseSourceRoot, stagedFiles.notices), join(paths.stageDirectory, stagedFiles.notices)),
  cp(join(releaseSourceRoot, stagedFiles.schema), join(paths.stageDirectory, stagedFiles.schema)),
])

const [installerStats, appStats, sidecarStats, installerHash, appHash, sidecarHash, gitCommit, gitStatus, signature] = await Promise.all([
  stat(paths.installer),
  stat(paths.builtApp),
  stat(paths.bundledSidecar),
  sha256File(paths.installer),
  sha256File(paths.builtApp),
  sha256File(paths.bundledSidecar),
  gitOutput(['rev-parse', 'HEAD']),
  gitOutput(['status', '--porcelain=v1', '--untracked-files=all']),
  inspectAuthenticodeSignature(paths.installer),
])

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
  target: {
    platform: metadata.platform,
    arch: metadata.arch,
    format: 'nsis',
    installScope: metadata.installMode,
  },
  source: {
    gitCommit,
    workingTreeDirty: Boolean(gitStatus),
  },
  build: {
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    tauriCliVersion: metadata.tauriCliVersion,
    electronFallbackVersion: metadata.electronVersion,
    webview2Mode: metadata.webview2Mode,
  },
  artifacts: [
    {
      role: 'windows-x64-nsis-installer',
      file: stagedFiles.installer,
      bytes: installerStats.size,
      sha256: installerHash,
      signature,
    },
  ],
  components: {
    application: {
      file: metadata.appExecutable,
      bytes: appStats.size,
      sha256: appHash,
    },
    sidecar: {
      file: metadata.sidecarRuntimeFilename,
      bytes: sidecarStats.size,
      sha256: sidecarHash,
      nodeMajor: 22,
      systemNodeRequired: false,
      parentControl: 'stdio',
    },
  },
  externalDependencies: [
    { name: 'WebView2 Runtime', bundled: 'bootstrapper', required: true, discovery: 'tauri-installer' },
    { name: 'ComfyUI', bundled: false, required: false, discovery: 'user-confirmed-loopback-runtime' },
    { name: 'H3 models and custom nodes', bundled: false, required: false, discovery: 'fixed-workflow-capability-probe' },
    { name: 'FFmpeg/rembg/Real-ESRGAN', bundled: false, required: false, discovery: 'local-processor-capability-probe' },
  ],
  licensing: {
    status: 'stage-review-required',
    publicCommercialReleaseReady: false,
    noticeFile: stagedFiles.notices,
    limitationsFile: stagedFiles.limitations,
    unresolved: [
      'Complete Node.js transitive third-party notice review',
      'Commercial redistribution review for every optional external processor and model',
      'Windows code-signing certificate and timestamp policy',
    ],
  },
  excluded: [
    'code-signing-certificate',
    'automatic-updater-and-rollback',
    'ComfyUI-Python-custom-nodes-and-model-weights',
    'cloud-accounts-payments-and-API-credentials',
  ],
  files: {
    installGuide: stagedFiles.installGuide,
    limitations: stagedFiles.limitations,
    notices: stagedFiles.notices,
    schema: stagedFiles.schema,
    checksums: stagedFiles.checksums,
  },
}
validateReleaseManifestShape(manifest, metadata)
await writeFile(
  join(paths.stageDirectory, stagedFiles.manifest),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
)

const checksumCandidates = (await readdir(paths.stageDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name !== stagedFiles.checksums)
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right, 'en'))
const checksumLines = []
for (const filename of checksumCandidates) {
  checksumLines.push(`${await sha256File(join(paths.stageDirectory, filename))}  ${filename}`)
}
await writeFile(
  join(paths.stageDirectory, stagedFiles.checksums),
  `${checksumLines.join('\n')}\n`,
  'utf8',
)

console.log(`✓ AEONQUILL release stage: ${paths.stageDirectory}`)
console.log(`✓ Installer ${(installerStats.size / 1024 / 1024).toFixed(1)} MiB, SHA-256 ${installerHash}`)
console.log(`✓ Authenticode: ${signature.status}; source dirty=${Boolean(gitStatus)}`)
