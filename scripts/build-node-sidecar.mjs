import { execFile, spawn } from 'node:child_process'
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { loadReleaseMetadata, resolveReleasePaths } from '../desktop/release/release-meta.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const metadata = await loadReleaseMetadata(projectRoot)
const releasePaths = resolveReleasePaths(metadata)
const pkgCli = join(projectRoot, 'node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js')
const outputDirectory = join(projectRoot, 'desktop', 'tauri', 'src-tauri', 'binaries')
const outputName = metadata.sidecarBuildFilename
const outputPath = releasePaths.sourceSidecar
const temporaryPath = join(outputDirectory, outputName.replace(/\.exe$/i, '.building.exe'))
const embeddedIdentityPath = join(projectRoot, '.runtime', 'release', 'embedded-build-identity.json')
const commitPattern = /^[a-f0-9]{40}$/u

async function fileExists(pathname) {
  try {
    return (await stat(pathname)).isFile()
  } catch {
    return false
  }
}

async function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      windowsHide: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        PKG_CACHE_PATH: join(projectRoot, '.runtime', 'toolchains', 'pkg-cache'),
      },
    })
    child.once('error', rejectPromise)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`Node sidecar packaging exited with code ${code}`))
    })
  })
}

if (Number(process.versions.node.split('.')[0]) < 22) {
  throw new Error('The AEONQUILL sidecar build requires Node.js 22 or newer')
}
if (!(await fileExists(join(projectRoot, 'dist', 'index.html')))) {
  throw new Error('Frontend dist is missing; run npm run build first')
}
if (!(await fileExists(pkgCli))) throw new Error('The @yao-pkg/pkg CLI is not installed')

const { stdout: gitStatus } = await execFileAsync(
  'git.exe',
  ['status', '--porcelain=v1', '--untracked-files=all'],
  { cwd: projectRoot, windowsHide: true, encoding: 'utf8', timeout: 10_000 },
)
if (gitStatus.trim()) throw new Error('The self-contained sidecar must be packaged from a clean Git worktree')
const { stdout: commitSource } = await execFileAsync('git.exe', ['rev-parse', 'HEAD'], {
  cwd: projectRoot,
  windowsHide: true,
  encoding: 'utf8',
  timeout: 5_000,
})
const sourceCommit = commitSource.trim().toLocaleLowerCase('en-US')
if (!commitPattern.test(sourceCommit)) throw new Error('A 40-character source commit is required for sidecar packaging')
const configuredCommit = String(process.env.AEONQUILL_BUILD_COMMIT || '').trim().toLocaleLowerCase('en-US')
if (configuredCommit && configuredCommit !== sourceCommit) {
  throw new Error(`AEONQUILL_BUILD_COMMIT does not match clean HEAD: ${configuredCommit}`)
}
await mkdir(dirname(embeddedIdentityPath), { recursive: true })
await writeFile(embeddedIdentityPath, `${JSON.stringify({
  schemaVersion: 'aeonquill-embedded-build-identity-v1',
  productVersion: metadata.version,
  functionalTrack: metadata.functionalTrack,
  buildIdentityVersion: metadata.buildIdentityVersion,
  runtimeRegistryVersion: metadata.runtimeRegistryVersion,
  sourceCommit,
}, null, 2)}\n`, 'utf8')

await mkdir(outputDirectory, { recursive: true })
await unlink(temporaryPath).catch((error) => {
  if (error.code !== 'ENOENT') throw error
})
await run(process.execPath, [
  pkgCli,
  '--config', join(projectRoot, 'desktop', 'sidecar.pkg.json'),
  '--targets', 'node22-win-x64',
  '--output', temporaryPath,
  join(projectRoot, 'server', 'index.mjs'),
])
await unlink(outputPath).catch((error) => {
  if (error.code !== 'ENOENT') throw error
})
await rename(temporaryPath, outputPath)

const outputStats = await stat(outputPath)
console.log(`✓ Node sidecar: ${outputPath}`)
console.log(`✓ Size: ${(outputStats.size / 1024 / 1024).toFixed(1)} MiB`)
console.log(`✓ Embedded source commit: ${sourceCommit}`)
