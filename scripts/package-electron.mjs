import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packager } from '@electron/packager'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const runtimeRoot = resolve(projectRoot, '.runtime')
const stageRoot = join(runtimeRoot, 'desktop-stage', 'electron')
const releaseRoot = join(runtimeRoot, 'releases', 'electron')
const qaReportPath = join(runtimeRoot, 'qa', 'electron-package-final.json')
const electronVersion = '43.4.0'
const electronZipName = `electron-v${electronVersion}-win32-x64.zip`

function assertRuntimeTarget(target) {
  const relativePath = relative(runtimeRoot, resolve(target))
  assert.ok(relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath), `Unsafe runtime target: ${target}`)
}

async function sha256(pathname) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(pathname)) hash.update(chunk)
  return hash.digest('hex')
}

async function findElectronZip(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const pathname = join(directory, entry.name)
      if (entry.isDirectory()) {
        const nested = await findElectronZip(pathname)
        if (nested) return nested
      } else if (entry.isFile() && entry.name === electronZipName) {
        return pathname
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return null
}

async function directoryStats(rootDirectory) {
  let bytes = 0
  let files = 0
  const entries = await readdir(rootDirectory, { withFileTypes: true })
  for (const entry of entries) {
    const pathname = join(rootDirectory, entry.name)
    if (entry.isDirectory()) {
      const nested = await directoryStats(pathname)
      bytes += nested.bytes
      files += nested.files
    } else if (entry.isFile()) {
      bytes += (await stat(pathname)).size
      files += 1
    }
  }
  return { bytes, files }
}

for (const target of [stageRoot, releaseRoot]) assertRuntimeTarget(target)
await rm(stageRoot, { recursive: true, force: true })
await mkdir(join(stageRoot, 'src', 'lib'), { recursive: true })

await Promise.all([
  cp(join(projectRoot, 'dist'), join(stageRoot, 'dist'), { recursive: true }),
  cp(join(projectRoot, 'server'), join(stageRoot, 'server'), { recursive: true }),
  cp(join(projectRoot, 'desktop', 'electron'), join(stageRoot, 'desktop', 'electron'), { recursive: true }),
  cp(join(projectRoot, 'desktop', 'shared'), join(stageRoot, 'desktop', 'shared'), { recursive: true }),
  cp(join(projectRoot, 'src', 'lib', 'canvasCore.mjs'), join(stageRoot, 'src', 'lib', 'canvasCore.mjs')),
])
await writeFile(join(stageRoot, 'package.json'), `${JSON.stringify({
  name: 'miaohui-desktop',
  productName: 'MiaoHui',
  version: '0.1.0',
  private: true,
  type: 'module',
  main: 'desktop/electron/main.mjs',
}, null, 2)}\n`, 'utf8')

const checksums = JSON.parse(await readFile(join(projectRoot, 'node_modules', 'electron', 'checksums.json'), 'utf8'))
const expectedElectronHash = checksums[electronZipName]
assert.match(expectedElectronHash, /^[a-f0-9]{64}$/)
const electronCacheRoot = join(process.env.LOCALAPPDATA || '', 'electron', 'Cache')
const electronZipPath = await findElectronZip(electronCacheRoot)
if (!electronZipPath) throw new Error(`Verified Electron archive not found in ${electronCacheRoot}`)
const actualElectronHash = await sha256(electronZipPath)
assert.equal(actualElectronHash, expectedElectronHash, 'Electron archive checksum mismatch')

await mkdir(releaseRoot, { recursive: true })
const packagePaths = await packager({
  dir: stageRoot,
  out: releaseRoot,
  name: 'MiaoHui',
  executableName: 'MiaoHui',
  appVersion: '0.1.0',
  buildVersion: '0.1.0',
  electronVersion,
  electronZipDir: dirname(electronZipPath),
  platform: 'win32',
  arch: 'x64',
  icon: join(projectRoot, 'desktop', 'tauri', 'src-tauri', 'icons', 'icon.ico'),
  overwrite: true,
  prune: false,
  asar: false,
  win32metadata: {
    CompanyName: 'MiaoHui',
    FileDescription: 'MiaoHui local-first creative workstation',
    OriginalFilename: 'MiaoHui.exe',
    ProductName: 'MiaoHui',
    InternalName: 'MiaoHui',
  },
})
assert.equal(packagePaths.length, 1)
const packageDirectory = packagePaths[0]
const packageStats = await directoryStats(packageDirectory)
const executableStats = await stat(join(packageDirectory, 'MiaoHui.exe'))
const stageStats = await directoryStats(stageRoot)
const report = {
  schemaVersion: 1,
  status: 'passed',
  shell: 'electron',
  version: electronVersion,
  platform: 'win32',
  arch: 'x64',
  unsigned: true,
  archive: {
    filename: electronZipName,
    sha256: actualElectronHash,
    verifiedAgainstPackageChecksums: true,
  },
  staging: stageStats,
  package: {
    directoryName: packageDirectory.split(/[\\/]/).pop(),
    bytes: packageStats.bytes,
    files: packageStats.files,
    executableBytes: executableStats.size,
  },
  builtAt: new Date().toISOString(),
}
await mkdir(dirname(qaReportPath), { recursive: true })
await writeFile(qaReportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(`✓ Electron package: ${packageDirectory}`)
console.log(`✓ ${(packageStats.bytes / 1024 / 1024).toFixed(1)} MiB across ${packageStats.files} files`)
console.log(`✓ Electron archive SHA-256 ${actualElectronHash.slice(0, 12)}… verified`)
console.log(`✓ Report: ${qaReportPath}`)
