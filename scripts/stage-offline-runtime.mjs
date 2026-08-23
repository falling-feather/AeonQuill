import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  cp,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  OFFLINE_RUNTIME_PACKAGE_ID,
  offlineRuntimeLayout,
  sha256File,
} from '../server/offline-runtime.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const internalRuntimeRoot = resolve(projectRoot, '.runtime')
const downloadRoot = resolve(projectRoot, '下载')
const lockPath = join(projectRoot, 'desktop', 'runtime', 'runtime-lock.json')
const dependencyCacheRoot = join(internalRuntimeRoot, 'downloads', 'rel012')
const defaultBaseRuntimeRoot = 'D:\\AEONQUILL-Package\\runtime\\aeonquill-comfyui-h3-cu129-win-x64-v1'
const defaultCandidateRoot = 'D:\\AEONQUILL-Package\\runtime-candidates\\aeonquill-comfyui-h3-cu130-win-x64-v2'
const defaultFullRoot = join(downloadRoot, '光阴砚AEONQUILL-0.6.0-Windows-x64-开箱即用版')
const defaultOutput = join(defaultFullRoot, 'runtime', OFFLINE_RUNTIME_PACKAGE_ID)
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
const BASE_RUNTIME_PACKAGE_ID = 'aeonquill-comfyui-h3-cu129-win-x64-v1'

function parseArgs(argv) {
  const values = {}
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument)
    if (!match) throw new Error(`Unsupported argument: ${argument}`)
    values[match[1]] = match[2]
  }
  return values
}

function isInside(root, target) {
  const relation = relative(resolve(root), resolve(target))
  return Boolean(relation) && !relation.startsWith('..') && !isAbsolute(relation)
}

function assertStagingTarget(target) {
  assert.ok(
    isInside(internalRuntimeRoot, target) || isInside(downloadRoot, target),
    `Unsafe runtime staging target: ${target}`,
  )
}

function portablePath(pathname) {
  return pathname.split(sep).join('/')
}

function canonicalDistributionName(value) {
  return String(value || '').trim().toLowerCase().replace(/[-_.]+/g, '-')
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

async function gitOutput(directory, args) {
  const { stdout } = await execFileAsync('git.exe', ['-C', directory, ...args], {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  })
  return stdout.trim()
}

function createComfyFilter(comfyRoot, lock) {
  const allowedNodes = new Set(
    lock.customNodes.filter((entry) => entry.source === 'candidate').map((entry) => entry.directory),
  )
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
    if (relativePath === 'extra_model_paths.yaml' || relativePath === 'extra_model_paths.yaml.example') return false
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

function createPortableFilter(sourceRoot) {
  return (source) => {
    const relativePath = portablePath(relative(sourceRoot, source))
    if (!relativePath) return true
    const parts = relativePath.split('/')
    if (parts.some((part) => GENERIC_EXCLUDED_DIRECTORIES.has(part))) return false
    if (parts.includes('pyvenv.cfg')) return false
    return !/\.py[co]$/i.test(relativePath)
  }
}

async function validateSourceRuntime({ lock, baseRuntimeRoot, candidateRoot, wheelPath }) {
  const candidateComfyRoot = join(candidateRoot, 'ComfyUI')
  const candidatePython = join(candidateRoot, '.venv', 'Scripts', 'python.exe')
  const candidateNodeRoot = join(candidateComfyRoot, 'custom_nodes', 'ComfyUI-MiniMax-H3-Turbo')
  assert.equal(await gitOutput(candidateComfyRoot, ['rev-parse', 'HEAD']), lock.runtime.comfyuiCommit)
  assert.equal(await gitOutput(candidateComfyRoot, ['status', '--porcelain=v1']), '', 'Candidate ComfyUI must be clean')
  const candidateNode = lock.customNodes.find((entry) => entry.source === 'candidate')
  assert.equal(await gitOutput(candidateNodeRoot, ['rev-parse', 'HEAD']), candidateNode.commit)
  assert.equal(await gitOutput(candidateNodeRoot, ['status', '--porcelain=v1']), '', 'MiniMax node must be clean')

  const baseManifest = JSON.parse(await readFile(join(baseRuntimeRoot, 'runtime-manifest.json'), 'utf8'))
  assert.equal(baseManifest.packageId, BASE_RUNTIME_PACKAGE_ID, 'Unexpected base runtime package')
  const impactInit = 'ComfyUI/custom_nodes/ComfyUI-Impact-Pack/__init__.py'
  const recordedImpact = baseManifest.criticalFiles.find((entry) => entry.path === impactInit)
  assert.ok(recordedImpact, 'Base runtime does not bind Impact Pack')
  assert.equal(await sha256File(join(baseRuntimeRoot, ...impactInit.split('/'))), recordedImpact.sha256)

  const { stdout: candidateProbe } = await execFileAsync(candidatePython, ['-c', [
    'import json,sys,torch,torchvision,torchaudio',
    'print(json.dumps({"python":sys.version.split()[0],"torch":torch.__version__,"torchvision":torchvision.__version__,"torchaudio":torchaudio.__version__,"cuda":torch.version.cuda}))',
  ].join(';')], { windowsHide: true, encoding: 'utf8', timeout: 180_000 })
  const candidate = JSON.parse(candidateProbe.trim())
  assert.equal(candidate.python, lock.runtime.pythonVersion)
  assert.equal(candidate.torch, lock.runtime.torchVersion)
  assert.equal(candidate.torchvision, lock.runtime.torchvisionVersion)
  assert.equal(candidate.torchaudio, lock.runtime.torchaudioVersion)
  assert.equal(candidate.cuda, lock.runtime.cudaRuntime)

  for (const model of lock.models) {
    const sourcePath = join(baseRuntimeRoot, ...model.path.split('/'))
    const sourceStats = await stat(sourcePath)
    assert.equal(sourceStats.size, model.bytes, `${model.path} byte size does not match lock`)
    assert.equal(await sha256File(sourcePath), model.sha256, `${model.path} SHA-256 does not match lock`)
  }
  const wheel = lock.pythonPackages.find((entry) => entry.name === 'numpy')
  assert.ok(wheel)
  assert.equal(await sha256File(wheelPath), wheel.sha256, 'Pinned NumPy wheel SHA-256 changed')
}

async function overlayCandidateSitePackages({ baseRuntimeRoot, candidateRoot, destination }) {
  const sourcePythonRoot = join(baseRuntimeRoot, 'python')
  const destinationPythonRoot = join(destination, 'python')
  console.log('→ Copying the portable Python base with image-processing dependencies')
  await cp(sourcePythonRoot, destinationPythonRoot, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    filter: createPortableFilter(sourcePythonRoot),
  })

  const sourceSitePackages = join(candidateRoot, '.venv', 'Lib', 'site-packages')
  const destinationSitePackages = join(destinationPythonRoot, 'Lib', 'site-packages')
  const entries = await readdir(sourceSitePackages, { withFileTypes: true })
  const candidateDistributions = new Set()
  for (const entry of entries.filter((item) => item.isDirectory() && item.name.endsWith('.dist-info'))) {
    const metadata = await readFile(join(sourceSitePackages, entry.name, 'METADATA'), 'utf8').catch(() => '')
    const packageName = canonicalDistributionName(/^Name:\s*(.+)$/mi.exec(metadata)?.[1])
    if (packageName && packageName !== 'numpy') candidateDistributions.add(packageName)
  }
  const destinationEntries = await readdir(destinationSitePackages, { withFileTypes: true })
  for (const entry of destinationEntries.filter((item) => item.isDirectory() && item.name.endsWith('.dist-info'))) {
    const metadata = await readFile(join(destinationSitePackages, entry.name, 'METADATA'), 'utf8').catch(() => '')
    const packageName = canonicalDistributionName(/^Name:\s*(.+)$/mi.exec(metadata)?.[1])
    if (packageName && candidateDistributions.has(packageName)) {
      await rm(join(destinationSitePackages, entry.name), { recursive: true, force: true })
    }
  }
  console.log(`→ Overlaying ${entries.length} cu130 site-packages entries without venv path inheritance`)
  for (const entry of entries) {
    if (/^numpy(?:$|[-.])|^numpy\.libs$/i.test(entry.name)) continue
    const source = join(sourceSitePackages, entry.name)
    const target = join(destinationSitePackages, entry.name)
    await rm(target, { recursive: true, force: true })
    await cp(source, target, {
      recursive: entry.isDirectory(),
      force: true,
      preserveTimestamps: true,
      filter: entry.isDirectory() ? createPortableFilter(source) : undefined,
    })
  }

  const wheelDirectory = dependencyCacheRoot
  const pythonPath = join(destinationPythonRoot, 'python.exe')
  await execFileAsync(pythonPath, [
    '-m', 'pip', 'install',
    '--disable-pip-version-check',
    '--no-input',
    '--no-index',
    '--find-links', wheelDirectory,
    '--force-reinstall',
    '--no-deps',
    `numpy==2.2.6`,
  ], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
  })

  const installedDistributions = new Map()
  for (const entry of (await readdir(destinationSitePackages, { withFileTypes: true }))) {
    if (!entry.isDirectory() || !entry.name.endsWith('.dist-info')) continue
    const metadata = await readFile(join(destinationSitePackages, entry.name, 'METADATA'), 'utf8').catch(() => '')
    const packageName = canonicalDistributionName(/^Name:\s*(.+)$/mi.exec(metadata)?.[1])
    if (!packageName) continue
    const previous = installedDistributions.get(packageName)
    assert.equal(previous, undefined, `Duplicate Python distribution metadata for ${packageName}: ${previous}, ${entry.name}`)
    installedDistributions.set(packageName, entry.name)
  }
}

async function copyRuntime({ lock, baseRuntimeRoot, candidateRoot, destination }) {
  const layout = offlineRuntimeLayout(destination)
  const candidateComfyRoot = join(candidateRoot, 'ComfyUI')
  console.log('→ Copying frozen ComfyUI 0.31 core and the cu130 MiniMax node')
  await cp(candidateComfyRoot, layout.comfyRoot, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    filter: createComfyFilter(candidateComfyRoot, lock),
  })

  const impactSource = join(baseRuntimeRoot, 'ComfyUI', 'custom_nodes', 'ComfyUI-Impact-Pack')
  const impactDestination = join(layout.comfyRoot, 'custom_nodes', 'ComfyUI-Impact-Pack')
  await cp(impactSource, impactDestination, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    filter: createPortableFilter(impactSource),
  })
  for (const directory of ['input', 'output', 'temp']) {
    await mkdir(join(layout.comfyRoot, directory), { recursive: true })
  }

  console.log(`→ Copying ${lock.models.length} allowlisted H3, SeedVR2, SAM and rembg weights`)
  for (const model of lock.models) {
    const source = join(baseRuntimeRoot, ...model.path.split('/'))
    const target = join(destination, ...model.path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, { force: true, preserveTimestamps: true })
  }

  await overlayCandidateSitePackages({ baseRuntimeRoot, candidateRoot, destination })

  console.log('→ Copying fixed FFmpeg and Real-ESRGAN portable tools')
  for (const relativePath of [
    'tools/ffmpeg/bin/ffmpeg.exe',
    'tools/ffmpeg/bin/ffprobe.exe',
    'tools/ffmpeg/LICENSE',
    'tools/ffmpeg/README.txt',
    'tools/realesrgan-ncnn-vulkan/realesrgan-ncnn-vulkan.exe',
    'tools/realesrgan-ncnn-vulkan/vcomp140.dll',
    'tools/realesrgan-ncnn-vulkan/README_windows.md',
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
  ]) {
    const source = join(baseRuntimeRoot, ...relativePath.split('/'))
    const target = join(destination, ...relativePath.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, { force: true, preserveTimestamps: true })
  }

  const sourceLicenses = join(baseRuntimeRoot, 'licenses')
  const destinationLicenses = join(destination, 'licenses')
  await cp(sourceLicenses, destinationLicenses, { recursive: true, force: true, preserveTimestamps: true })
  await cp(
    join(sourceLicenses, 'H3-Turbo-Apache-2.0.txt'),
    join(destinationLicenses, 'SeedVR2-Apache-2.0.txt'),
    { force: true },
  )
}

async function validateStagedPython(lock, destination) {
  const layout = offlineRuntimeLayout(destination)
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const systemOnlyPath = [join(systemRoot, 'System32'), systemRoot, join(systemRoot, 'System32', 'Wbem')].join(';')
  const { stdout } = await execFileAsync(layout.pythonPath, ['-c', [
    'import json,sys,torch,torchvision,torchaudio,numpy,scipy,cv2,rembg,onnxruntime,segment_anything,PIL,aiohttp,numba,transformers,huggingface_hub',
    'print(json.dumps({"python":sys.version.split()[0],"torch":torch.__version__,"torchvision":torchvision.__version__,"torchaudio":torchaudio.__version__,"cuda":torch.version.cuda,"numpy":numpy.__version__,"scipy":scipy.__version__,"cv2":cv2.__version__,"numba":numba.__version__,"onnxruntime":onnxruntime.__version__,"transformers":transformers.__version__,"huggingfaceHub":huggingface_hub.__version__,"providers":onnxruntime.get_available_providers()}))',
  ].join(';')], {
    cwd: layout.comfyRoot,
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
      PYTHONNOUSERSITE: '1',
    },
  })
  const probe = JSON.parse(stdout.trim())
  assert.equal(probe.python, lock.runtime.pythonVersion)
  assert.equal(probe.torch, lock.runtime.torchVersion)
  assert.equal(probe.torchvision, lock.runtime.torchvisionVersion)
  assert.equal(probe.torchaudio, lock.runtime.torchaudioVersion)
  assert.equal(probe.cuda, lock.runtime.cudaRuntime)
  assert.equal(probe.numpy, lock.runtime.numpyVersion)
  assert.equal(probe.transformers, lock.runtime.transformersVersion)
  assert.equal(probe.huggingfaceHub, lock.runtime.huggingfaceHubVersion)
  assert.ok(probe.providers.includes('CUDAExecutionProvider'))
  return probe
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
  return {
    entries,
    lines,
    treeSha256: createHash('sha256').update(`${lines.join('\n')}\n`).digest('hex'),
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
    'python/Lib/site-packages/torch/__init__.py',
    'python/Lib/site-packages/numpy/__init__.py',
    'python/Lib/site-packages/rembg/__init__.py',
    'tools/ffmpeg/bin/ffmpeg.exe',
    'tools/ffmpeg/bin/ffprobe.exe',
    'tools/realesrgan-ncnn-vulkan/realesrgan-ncnn-vulkan.exe',
    ...lock.models.map((entry) => entry.path),
  ]
}

const args = parseArgs(process.argv.slice(2))
const lock = JSON.parse(await readFile(lockPath, 'utf8'))
assert.equal(lock.packageId, OFFLINE_RUNTIME_PACKAGE_ID)
const baseRuntimeRoot = resolve(args['base-runtime-root'] || process.env.AEONQUILL_BASE_RUNTIME_SOURCE || defaultBaseRuntimeRoot)
const candidateRoot = resolve(args['candidate-root'] || process.env.AEONQUILL_CU130_CANDIDATE_SOURCE || defaultCandidateRoot)
const output = resolve(args.output || defaultOutput)
const numpyPackage = lock.pythonPackages.find((entry) => entry.name === 'numpy')
const wheelPath = join(dependencyCacheRoot, numpyPackage.wheel)
assertStagingTarget(output)
await mkdir(dirname(output), { recursive: true })
for (const pathname of [baseRuntimeRoot, candidateRoot]) {
  assert.equal(await directoryExists(pathname), true, `Runtime source directory is missing: ${pathname}`)
}
for (const pathname of [
  join(candidateRoot, 'ComfyUI', 'main.py'),
  join(candidateRoot, '.venv', 'Scripts', 'python.exe'),
  join(baseRuntimeRoot, 'python', 'python.exe'),
  wheelPath,
]) assert.equal(await fileExists(pathname), true, `Required runtime dependency is missing: ${pathname}`)

console.log(`→ Validating standalone runtime sources for ${lock.packageId}`)
await validateSourceRuntime({ lock, baseRuntimeRoot, candidateRoot, wheelPath })
const temporary = await mkdtemp(join(dirname(output), `${OFFLINE_RUNTIME_PACKAGE_ID}.building-`))
assertStagingTarget(temporary)
try {
  await copyRuntime({ lock, baseRuntimeRoot, candidateRoot, destination: temporary })
  const pythonProbe = await validateStagedPython(lock, temporary)
  console.log(`✓ Portable Python probe: Torch ${pythonProbe.torch} · CUDA ${pythonProbe.cuda} · NumPy ${pythonProbe.numpy}`)

  console.log('→ Hashing complete standalone runtime inventory')
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
    customNodes: lock.customNodes,
    models: lock.models,
    tools: lock.tools,
    pythonPackages: lock.pythonPackages,
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
  console.log(`✓ Standalone runtime: ${output}`)
  console.log(`✓ ${(inventory.bytes / 1024 ** 3).toFixed(2)} GiB · ${inventory.entries.length} files · tree ${inventory.treeSha256}`)
} catch (error) {
  await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  throw error
}
