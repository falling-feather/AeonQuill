import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  cp,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  OFFLINE_RUNTIME_PACKAGE_ID,
  offlineRuntimeLayout,
  sha256File,
} from '../server/offline-runtime.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const runtimeRoot = resolve(projectRoot, '.runtime')
const lockPath = join(projectRoot, 'desktop', 'runtime', 'runtime-lock.json')
const downloadsRoot = join(runtimeRoot, 'downloads', 'rel004')
const defaultOutput = join(
  runtimeRoot,
  'releases',
  'offline',
  'AEONQUILL_0.4.3_windows_x64_full',
  'runtime',
  OFFLINE_RUNTIME_PACKAGE_ID,
)
const WEIGHT_EXTENSION = /\.(?:bin|ckpt|onnx|pt|pth|safetensors)$/i
const GENERIC_EXCLUDED_DIRECTORIES = new Set(['.git', '.github', '__pycache__', '.pytest_cache'])
const COMFY_EXCLUDED_TOP_LEVEL = new Set([
  '.ci',
  'alembic_db',
  'input',
  'output',
  'script_examples',
  'temp',
  'tests',
  'tests-unit',
  'user',
])

function parseArgs(argv) {
  const values = {}
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument)
    if (!match) throw new Error(`Unsupported argument: ${argument}`)
    values[match[1]] = match[2]
  }
  return values
}

function assertRuntimeTarget(target) {
  const relation = relative(runtimeRoot, resolve(target))
  assert.ok(relation && !relation.startsWith('..') && !isAbsolute(relation), `Unsafe runtime staging target: ${target}`)
}

function portablePath(pathname) {
  return pathname.split(sep).join('/')
}

async function fileExists(pathname) {
  try {
    return (await stat(pathname)).isFile()
  } catch {
    return false
  }
}

async function directoryExists(pathname) {
  try {
    return (await stat(pathname)).isDirectory()
  } catch {
    return false
  }
}

async function loadSourceConfig() {
  const pathname = join(projectRoot, 'config', 'local.json')
  return JSON.parse(await readFile(pathname, 'utf8'))
}

async function gitOutput(directory, args) {
  const { stdout } = await execFileAsync('git.exe', ['-C', directory, ...args], {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  })
  return stdout.trim()
}

async function validateSourceRuntime({ lock, comfyRoot, pythonRoot, ffmpegRoot }) {
  assert.equal(await gitOutput(comfyRoot, ['rev-parse', 'HEAD']), lock.runtime.comfyuiCommit, 'ComfyUI commit does not match runtime lock')
  assert.equal(await gitOutput(comfyRoot, ['status', '--porcelain=v1']), '', 'ComfyUI source worktree must be clean')
  for (const node of lock.customNodes) {
    const nodeRoot = join(comfyRoot, 'custom_nodes', node.directory)
    assert.equal(await gitOutput(nodeRoot, ['rev-parse', 'HEAD']), node.commit, `${node.directory} commit does not match runtime lock`)
    assert.equal(await gitOutput(nodeRoot, ['status', '--porcelain=v1']), '', `${node.directory} source worktree must be clean`)
  }
  const pythonPath = join(pythonRoot, 'python.exe')
  const { stdout: pythonProbe } = await execFileAsync(pythonPath, ['-c', [
    'import json,sys,torch,rembg,onnxruntime,segment_anything',
    'print(json.dumps({"python":sys.version.split()[0],"torch":torch.__version__,"cuda":torch.version.cuda,"providers":onnxruntime.get_available_providers()}))',
  ].join(';')], { windowsHide: true, encoding: 'utf8', timeout: 60_000 })
  const python = JSON.parse(pythonProbe.trim())
  assert.equal(python.python, lock.runtime.pythonVersion)
  assert.equal(python.torch, lock.runtime.torchVersion)
  assert.equal(python.cuda, lock.runtime.cudaRuntime)
  assert.ok(python.providers.includes('CUDAExecutionProvider'), 'ONNX Runtime CUDA provider is missing')
  for (const model of lock.models.filter((entry) => entry.path.startsWith('ComfyUI/'))) {
    const sourcePath = join(dirname(comfyRoot), model.path)
    const sourceStats = await stat(sourcePath)
    assert.equal(sourceStats.size, model.bytes, `${model.path} byte size does not match runtime lock`)
    assert.equal(await sha256File(sourcePath), model.sha256, `${model.path} SHA-256 does not match runtime lock`)
  }
  const ffmpegPath = join(ffmpegRoot, 'bin', 'ffmpeg.exe')
  const { stdout: ffmpegVersion } = await execFileAsync(ffmpegPath, ['-version'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.match(ffmpegVersion, /8\.0\.1-essentials_build-www\.gyan\.dev/)
}

function createComfyFilter(comfyRoot, lock) {
  const allowedNodes = new Set(lock.customNodes.map((entry) => entry.directory))
  const allowedWeights = new Set(
    lock.models
      .filter((entry) => entry.path.startsWith('ComfyUI/models/'))
      .map((entry) => entry.path.slice('ComfyUI/'.length)),
  )
  const allowedWeightAncestors = new Set(['models'])
  for (const pathname of allowedWeights) {
    const parts = pathname.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      allowedWeightAncestors.add(parts.slice(0, index).join('/'))
    }
  }
  return (source) => {
    const relativePath = portablePath(relative(comfyRoot, source))
    if (!relativePath) return true
    const parts = relativePath.split('/')
    if (parts.some((part) => GENERIC_EXCLUDED_DIRECTORIES.has(part))) return false
    if (COMFY_EXCLUDED_TOP_LEVEL.has(parts[0])) return false
    if (parts[0] === 'custom_nodes') {
      if (parts.length === 1) return true
      if (!allowedNodes.has(parts[1])) return false
    }
    if (parts[0] === 'models') {
      if (allowedWeightAncestors.has(relativePath) || allowedWeights.has(relativePath)) return true
      if (WEIGHT_EXTENSION.test(relativePath)) return false
      return parts.length === 1
    }
    return true
  }
}

function createPythonFilter(pythonRoot) {
  return (source) => {
    const relativePath = portablePath(relative(pythonRoot, source))
    if (!relativePath) return true
    const parts = relativePath.split('/')
    if (parts.some((part) => GENERIC_EXCLUDED_DIRECTORIES.has(part))) return false
    return !/\.py[co]$/i.test(relativePath)
  }
}

async function copyRuntime({ lock, comfyRoot, pythonRoot, ffmpegRoot, destination }) {
  const layout = offlineRuntimeLayout(destination)
  console.log('→ Copying frozen ComfyUI core, required nodes and allowlisted weights')
  await cp(comfyRoot, layout.comfyRoot, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    filter: createComfyFilter(comfyRoot, lock),
  })
  for (const directory of ['input', 'output', 'temp']) {
    await mkdir(join(layout.comfyRoot, directory), { recursive: true })
  }
  console.log('→ Copying self-contained Python 3.12 / CUDA 12.9 environment')
  await cp(pythonRoot, join(destination, 'python'), {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    filter: createPythonFilter(pythonRoot),
  })
  console.log('→ Copying FFmpeg, rembg model and Real-ESRGAN portable runtime')
  for (const filename of ['ffmpeg.exe', 'ffprobe.exe']) {
    await mkdir(join(destination, 'tools', 'ffmpeg', 'bin'), { recursive: true })
    await cp(join(ffmpegRoot, 'bin', filename), join(destination, 'tools', 'ffmpeg', 'bin', filename))
  }
  for (const filename of ['LICENSE', 'README.txt']) {
    await cp(join(ffmpegRoot, filename), join(destination, 'tools', 'ffmpeg', filename))
  }
  const u2netSource = join(downloadsRoot, 'u2netp.onnx')
  await mkdir(layout.rembgModelsPath, { recursive: true })
  await cp(u2netSource, join(layout.rembgModelsPath, 'u2netp.onnx'))
  const realEsrganSource = join(downloadsRoot, 'realesrgan-v0.2.5.0')
  await mkdir(layout.realEsrganModelsPath, { recursive: true })
  for (const filename of ['realesrgan-ncnn-vulkan.exe', 'vcomp140.dll', 'README_windows.md']) {
    await cp(join(realEsrganSource, filename), join(dirname(layout.realEsrganModelsPath), filename))
  }
  const realEsrganModelFiles = [
    'realesr-animevideov3-x2.bin',
    'realesr-animevideov3-x2.param',
    'realesr-animevideov3-x3.bin',
    'realesr-animevideov3-x3.param',
    'realesr-animevideov3-x4.bin',
    'realesr-animevideov3-x4.param',
    'realesrgan-x4plus-anime.bin',
    'realesrgan-x4plus-anime.param',
    'realesrgan-x4plus.bin',
    'realesrgan-x4plus.param',
  ]
  for (const filename of realEsrganModelFiles) {
    await cp(join(realEsrganSource, 'models', filename), join(layout.realEsrganModelsPath, filename))
  }
  const licensesDirectory = join(destination, 'licenses')
  await mkdir(licensesDirectory, { recursive: true })
  const licenseCopies = [
    [join(comfyRoot, 'LICENSE'), 'ComfyUI-GPL-3.0.txt'],
    [join(comfyRoot, 'custom_nodes', 'ComfyUI-Impact-Pack', 'LICENSE.txt'), 'ComfyUI-Impact-Pack-GPL-3.0.txt'],
    [join(downloadsRoot, 'H3-Turbo-LICENSE.txt'), 'H3-Turbo-Apache-2.0.txt'],
    [join(downloadsRoot, 'MiniMax-H3-LICENSE.txt'), 'MiniMax-H3-Community-License.txt'],
    [join(downloadsRoot, 'Python-3.12.10-LICENSE.txt'), 'Python-3.12.10-License.txt'],
    [join(downloadsRoot, 'Real-ESRGAN-LICENSE.txt'), 'Real-ESRGAN-BSD-3-Clause.txt'],
    [join(downloadsRoot, 'rembg-LICENSE.txt'), 'rembg-MIT.txt'],
    [join(downloadsRoot, 'Segment-Anything-LICENSE.txt'), 'Segment-Anything-Apache-2.0.txt'],
    [join(ffmpegRoot, 'LICENSE'), 'FFmpeg-GPL-3.0.txt'],
  ]
  for (const [source, filename] of licenseCopies) await cp(source, join(licensesDirectory, filename))
}

async function listFiles(root) {
  const files = []
  async function visit(directory) {
    const handle = await opendir(directory)
    for await (const entry of handle) {
      const pathname = join(directory, entry.name)
      if (entry.isDirectory()) await visit(pathname)
      else if (entry.isFile()) files.push(pathname)
      else throw new Error(`Offline runtime cannot contain links or special files: ${pathname}`)
    }
  }
  await visit(root)
  return files.sort((left, right) => portablePath(relative(root, left)).localeCompare(portablePath(relative(root, right)), 'en'))
}

async function createInventory(root) {
  const files = (await listFiles(root)).filter((pathname) => ![
    'runtime-manifest.json',
    'runtime-SHA256SUMS.txt',
  ].includes(portablePath(relative(root, pathname))))
  const entries = new Array(files.length)
  let cursor = 0
  const workers = Array.from({ length: 4 }, async () => {
    while (cursor < files.length) {
      const index = cursor
      cursor += 1
      const pathname = files[index]
      const fileStats = await stat(pathname)
      entries[index] = {
        path: portablePath(relative(root, pathname)),
        bytes: fileStats.size,
        sha256: await sha256File(pathname),
      }
    }
  })
  await Promise.all(workers)
  const lines = entries.map((entry) => `${entry.sha256}  ${entry.path}`)
  const treeSha256 = createHash('sha256').update(`${lines.join('\n')}\n`).digest('hex')
  return {
    entries,
    lines,
    treeSha256,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  }
}

function criticalPaths(lock) {
  return [
    'ComfyUI/main.py',
    'ComfyUI/comfyui_version.py',
    'ComfyUI/custom_nodes/ComfyUI-MiniMax-H3-Turbo/__init__.py',
    'ComfyUI/custom_nodes/ComfyUI-Impact-Pack/__init__.py',
    'python/python.exe',
    'python/python312.dll',
    'tools/ffmpeg/bin/ffmpeg.exe',
    'tools/ffmpeg/bin/ffprobe.exe',
    'tools/realesrgan-ncnn-vulkan/realesrgan-ncnn-vulkan.exe',
    'tools/realesrgan-ncnn-vulkan/models/realesr-animevideov3-x2.bin',
    'tools/realesrgan-ncnn-vulkan/models/realesr-animevideov3-x2.param',
    'tools/realesrgan-ncnn-vulkan/models/realesr-animevideov3-x3.bin',
    'tools/realesrgan-ncnn-vulkan/models/realesr-animevideov3-x3.param',
    'tools/realesrgan-ncnn-vulkan/models/realesr-animevideov3-x4.bin',
    'tools/realesrgan-ncnn-vulkan/models/realesr-animevideov3-x4.param',
    'tools/realesrgan-ncnn-vulkan/models/realesrgan-x4plus-anime.bin',
    'tools/realesrgan-ncnn-vulkan/models/realesrgan-x4plus-anime.param',
    'tools/realesrgan-ncnn-vulkan/models/realesrgan-x4plus.bin',
    'tools/realesrgan-ncnn-vulkan/models/realesrgan-x4plus.param',
    ...lock.models.map((entry) => entry.path),
  ]
}

const args = parseArgs(process.argv.slice(2))
const [lock, localConfig] = await Promise.all([
  readFile(lockPath, 'utf8').then(JSON.parse),
  loadSourceConfig(),
])
assert.equal(lock.packageId, OFFLINE_RUNTIME_PACKAGE_ID)
const comfyRoot = resolve(args['comfy-root'] || localConfig.comfyRoot)
const pythonRoot = resolve(args['python-root'] || dirname(localConfig.pythonPath))
const ffmpegRoot = resolve(args['ffmpeg-root'] || dirname(dirname(localConfig.imageTools?.ffmpegPath || '')))
const output = resolve(args.output || defaultOutput)
assertRuntimeTarget(output)
await mkdir(dirname(output), { recursive: true })
for (const pathname of [comfyRoot, pythonRoot, ffmpegRoot]) {
  assert.equal(await directoryExists(pathname), true, `Runtime source directory is missing: ${pathname}`)
}
for (const pathname of [
  join(downloadsRoot, 'u2netp.onnx'),
  join(downloadsRoot, 'realesrgan-v0.2.5.0', 'realesrgan-ncnn-vulkan.exe'),
  join(downloadsRoot, 'MiniMax-H3-LICENSE.txt'),
]) assert.equal(await fileExists(pathname), true, `Fetched runtime dependency is missing: ${pathname}`)

console.log(`→ Validating REL-004 source runtime against ${lock.packageId}`)
await validateSourceRuntime({ lock, comfyRoot, pythonRoot, ffmpegRoot })
const sourceU2net = lock.models.find((entry) => entry.path === 'models/rembg/u2netp.onnx')
assert.equal(await sha256File(join(downloadsRoot, 'u2netp.onnx')), sourceU2net.sha256)

const temporary = await mkdtemp(join(dirname(output), `${OFFLINE_RUNTIME_PACKAGE_ID}.building-`))
assertRuntimeTarget(temporary)
try {
  await copyRuntime({ lock, comfyRoot, pythonRoot, ffmpegRoot, destination: temporary })
  console.log('→ Hashing complete offline runtime inventory')
  const inventory = await createInventory(temporary)
  const byPath = new Map(inventory.entries.map((entry) => [entry.path, entry]))
  const criticalFiles = criticalPaths(lock).map((pathname) => {
    const entry = byPath.get(pathname)
    assert.ok(entry, `Critical runtime file was not staged: ${pathname}`)
    return entry
  })
  for (const model of lock.models) {
    const entry = byPath.get(model.path)
    assert.equal(entry.bytes, model.bytes, `${model.path} staged byte size changed`)
    assert.equal(entry.sha256, model.sha256, `${model.path} staged SHA-256 changed`)
  }
  const manifest = {
    schemaVersion: 1,
    packageId: lock.packageId,
    productVersion: lock.productVersion,
    platform: lock.platform,
    architecture: lock.architecture,
    distributionStatus: lock.distributionStatus,
    createdAt: new Date().toISOString(),
    runtime: lock.runtime,
    entrypoints: lock.entrypoints,
    criticalFiles,
    inventory: {
      file: 'runtime-SHA256SUMS.txt',
      files: inventory.entries.length,
      bytes: inventory.bytes,
      treeSha256: inventory.treeSha256,
    },
    licensing: lock.licensing,
    excluded: lock.excluded,
  }
  await writeFile(join(temporary, 'runtime-SHA256SUMS.txt'), `${inventory.lines.join('\n')}\n`, 'utf8')
  await writeFile(join(temporary, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await rm(output, { recursive: true, force: true })
  await rename(temporary, output)
  console.log(`✓ Offline runtime: ${output}`)
  console.log(`✓ ${(inventory.bytes / 1024 ** 3).toFixed(2)} GiB · ${inventory.entries.length} files · tree ${inventory.treeSha256}`)
} catch (error) {
  await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  throw error
}
