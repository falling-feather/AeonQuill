import { spawn } from 'node:child_process'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const pkgCli = join(projectRoot, 'node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js')
const outputDirectory = join(projectRoot, 'desktop', 'tauri', 'src-tauri', 'binaries')
const outputName = 'miaohui-bridge-x86_64-pc-windows-msvc.exe'
const outputPath = join(outputDirectory, outputName)
const temporaryPath = join(outputDirectory, outputName.replace(/\.exe$/i, '.building.exe'))

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
  throw new Error('The MiaoHui sidecar build requires Node.js 22 or newer')
}
if (!(await fileExists(join(projectRoot, 'dist', 'index.html')))) {
  throw new Error('Frontend dist is missing; run npm run build first')
}
if (!(await fileExists(pkgCli))) throw new Error('The @yao-pkg/pkg CLI is not installed')

await mkdir(outputDirectory, { recursive: true })
await unlink(temporaryPath).catch((error) => {
  if (error.code !== 'ENOENT') throw error
})
await run(process.execPath, [
  pkgCli,
  '--sea',
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
