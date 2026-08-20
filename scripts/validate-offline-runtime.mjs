import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  OFFLINE_RUNTIME_PACKAGE_ID,
  probeOfflineRuntimePackage,
  sha256File,
} from '../server/offline-runtime.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const defaultRoot = join(
  projectRoot,
  '.runtime',
  'releases',
  'offline',
  'AEONQUILL_0.4.0_windows_x64_full',
  'runtime',
  OFFLINE_RUNTIME_PACKAGE_ID,
)
const rootArgument = process.argv.find((argument) => argument.startsWith('--root='))
const root = resolve(rootArgument ? rootArgument.slice('--root='.length) : defaultRoot)
const full = process.argv.includes('--full')

const runtime = await probeOfflineRuntimePackage({ packageRoot: root, verifyCriticalHashes: true })
assert.ok(runtime, 'Offline runtime manifest or critical-file validation failed')
assert.equal(runtime.packageId, OFFLINE_RUNTIME_PACKAGE_ID)
assert.equal(runtime.manifest.platform, 'windows')
assert.equal(runtime.manifest.architecture, 'x64')
assert.equal(runtime.manifest.distributionStatus, 'local-stage-only')
assert.equal(runtime.manifest.licensing.publicCommercialReleaseReady, false)

const systemRoot = process.env.SystemRoot || 'C:\\Windows'
const systemOnlyPath = [
  join(systemRoot, 'System32'),
  systemRoot,
  join(systemRoot, 'System32', 'Wbem'),
].join(';')
const { stdout: pythonProbe } = await execFileAsync(runtime.pythonPath, ['-c', [
  'import json,sys,torch,rembg,onnxruntime,segment_anything',
  'print(json.dumps({"python":sys.version.split()[0],"torch":torch.__version__,"cuda":torch.version.cuda,"providers":onnxruntime.get_available_providers()}))',
].join(';')], {
  cwd: runtime.comfyRoot,
  windowsHide: true,
  encoding: 'utf8',
  timeout: 180_000,
  env: {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    PATH: systemOnlyPath,
    PATHEXT: process.env.PATHEXT,
  },
})
const python = JSON.parse(pythonProbe.trim())
assert.equal(python.python, runtime.manifest.runtime.pythonVersion)
assert.equal(python.torch, runtime.manifest.runtime.torchVersion)
assert.equal(python.cuda, runtime.manifest.runtime.cudaRuntime)
assert.ok(python.providers.includes('CUDAExecutionProvider'))

const { stdout: ffmpegVersion } = await execFileAsync(runtime.ffmpegPath, ['-version'], {
  windowsHide: true,
  encoding: 'utf8',
  timeout: 30_000,
  env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: systemOnlyPath, PATHEXT: process.env.PATHEXT },
})
assert.match(ffmpegVersion, /8\.0\.1-essentials_build-www\.gyan\.dev/)
try {
  await execFileAsync(runtime.realEsrganPath, ['-h'], {
    cwd: dirname(runtime.realEsrganPath),
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30_000,
    env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: systemOnlyPath, PATHEXT: process.env.PATHEXT },
  })
} catch (error) {
  const diagnostic = `${error.stdout || ''}\n${error.stderr || ''}`
  assert.match(diagnostic, /Usage: realesrgan-ncnn-vulkan|realesrgan-ncnn-vulkan -i/u)
}

if (full) {
  const checksumPath = join(root, runtime.manifest.inventory.file)
  const source = await readFile(checksumPath, 'utf8')
  const lines = source.trimEnd().split('\n')
  assert.equal(lines.length, runtime.manifest.inventory.files)
  assert.equal(createHash('sha256').update(`${lines.join('\n')}\n`).digest('hex'), runtime.manifest.inventory.treeSha256)
  let bytes = 0
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([^\r\n]+)$/.exec(line)
    assert.ok(match, `Invalid runtime checksum line: ${line}`)
    const pathname = join(root, ...match[2].split('/'))
    const fileStats = await stat(pathname)
    assert.equal(fileStats.isFile(), true)
    assert.equal(await sha256File(pathname), match[1], `${match[2]} SHA-256 mismatch`)
    bytes += fileStats.size
  }
  assert.equal(bytes, runtime.manifest.inventory.bytes)
}

console.log(`✓ Offline runtime ${runtime.packageId}`)
console.log(`✓ Python ${python.python} · Torch ${python.torch} · CUDA ${python.cuda}`)
console.log(`✓ Critical hashes valid${full ? `; full ${runtime.manifest.inventory.files}-file inventory valid` : ''}`)
