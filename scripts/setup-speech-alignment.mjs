import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ID = 'jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn'
const MODEL_REVISION = '99ccb2737be22b8bb50dcfcc39ad4d567fb90cfd'
const MODEL_WEIGHT_SHA256 = 'de031fd4b29e0c0667e5346450fadfe1326c89936b888b59c4ede608db763ee4'
const MODEL_FILES = [
  'config.json',
  'preprocessor_config.json',
  'special_tokens_map.json',
  'vocab.json',
  'pytorch_model.bin',
]
const PACKAGE_VERSIONS = Object.freeze({
  whisperx: '3.8.6',
  'faster-whisper': '1.2.0',
  nltk: '3.9.1',
  pandas: '2.2.3',
  pytz: '2024.2',
  tzdata: '2024.2',
})

const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)))
const defaults = {
  pythonPath: 'D:/comfyui apk/ComfyUI-aki(2)/ComfyUI-aki-v2/ComfyUI-aki-v2/python/python.exe',
  venvDirectory: join(workspace, '.runtime', 'tools', 'speech-alignment', 'venv'),
  wheelDirectory: join(workspace, '.runtime', 'tools', 'speech-alignment', 'wheels'),
  modelDirectory: join(workspace, '.runtime', 'models', 'speech-alignment', 'zh'),
  nltkDirectory: join(workspace, '.runtime', 'models', 'speech-alignment', 'zh', 'nltk_data'),
  recordPath: join(workspace, '.runtime', 'tools', 'speech-alignment', 'install-record.json'),
  ffmpegPath: 'D:/钮/特殊工具库/ffmpeg/bin/ffmpeg.exe',
  ffprobePath: 'D:/钮/特殊工具库/ffmpeg/bin/ffprobe.exe',
}

function argsFrom(argv) {
  const value = { ...defaults, install: false, downloadModel: false, downloadNltk: false, verifyOnly: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--install') value.install = true
    else if (argument === '--download-model') value.downloadModel = true
    else if (argument === '--download-nltk') value.downloadNltk = true
    else if (argument === '--verify-only') value.verifyOnly = true
    else if (argument.startsWith('--')) {
      const key = argument.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())
      if (!Object.hasOwn(value, key)) throw new Error(`Unknown option ${argument}`)
      const next = argv[index + 1]
      if (!next || next.startsWith('--')) throw new Error(`${argument} requires a value`)
      value[key] = next
      index += 1
    } else {
      throw new Error(`Unexpected argument ${argument}`)
    }
  }
  if (value.verifyOnly && (value.install || value.downloadModel || value.downloadNltk)) {
    throw new Error('--verify-only cannot be combined with installation or download options')
  }
  return value
}

function run(executable, commandArgs, { cwd = workspace, env = {}, input = null } = {}) {
  const result = spawnSync(executable, commandArgs, {
    cwd,
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${executable} ${commandArgs.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout || '').slice(-8_000)}`)
  }
  return result.stdout
}

function assertAbsolute(value, label) {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`)
  return value
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function fileRecord(directory, filename) {
  const path = join(directory, filename)
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`${filename} is not a file`)
  return { filename, bytes: info.size, sha256: await sha256(path) }
}

async function installVenv(config) {
  await mkdir(config.venvDirectory, { recursive: true })
  const venvPython = join(config.venvDirectory, 'Scripts', 'python.exe')
  try { await stat(venvPython) } catch {
    run(config.pythonPath, ['-m', 'venv', '--system-site-packages', '--prompt', 'aeonquill-speech-alignment', config.venvDirectory])
  }
  await mkdir(config.wheelDirectory, { recursive: true })
  const localWhisperx = join(config.wheelDirectory, `whisperx-${PACKAGE_VERSIONS.whisperx}-py3-none-any.whl`)
  const installTargets = [
    ...(await stat(localWhisperx).then(() => [localWhisperx]).catch(() => [`whisperx==${PACKAGE_VERSIONS.whisperx}`])),
    ...Object.entries(PACKAGE_VERSIONS)
    .filter(([name]) => name !== 'whisperx')
    .map(([name, version]) => `${name}==${version}`),
  ]
  for (const target of installTargets) {
    run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-deps', '--no-warn-script-location', '--upgrade', target])
  }
  return { venvPython }
}

async function downloadNltk(config, venvPython) {
  await mkdir(config.nltkDirectory, { recursive: true })
  run(venvPython, ['-c', [
    'import nltk, sys',
    `ok = nltk.download("punkt_tab", download_dir=${JSON.stringify(config.nltkDirectory)}, quiet=False)`,
    'raise SystemExit(0 if ok else 2)',
  ].join(';')], { env: { NLTK_DATA: config.nltkDirectory } })
}

async function downloadModel(config, venvPython) {
  await mkdir(config.modelDirectory, { recursive: true })
  const pattern = JSON.stringify(MODEL_FILES)
  const code = [
    'from huggingface_hub import snapshot_download',
    `snapshot_download(${JSON.stringify(REPO_ID)}, revision=${JSON.stringify(MODEL_REVISION)}, local_dir=${JSON.stringify(config.modelDirectory)}, allow_patterns=${pattern}, local_dir_use_symlinks=False)`,
  ].join('\n')
  run(venvPython, ['-c', code], { env: { HF_HUB_OFFLINE: '0', TRANSFORMERS_OFFLINE: '0' } })
}

async function verifyModel(config) {
  const configJson = JSON.parse(await readFile(join(config.modelDirectory, 'config.json'), 'utf8'))
  const preprocessor = JSON.parse(await readFile(join(config.modelDirectory, 'preprocessor_config.json'), 'utf8'))
  const vocab = JSON.parse(await readFile(join(config.modelDirectory, 'vocab.json'), 'utf8'))
  if (!Number.isInteger(configJson.vocab_size) || configJson.vocab_size <= 0) throw new Error('Model config has no bounded vocab_size')
  if (!Number.isInteger(preprocessor.sampling_rate) || preprocessor.sampling_rate !== 16_000) throw new Error('Model preprocessor sampling_rate must be 16000')
  if (!vocab || typeof vocab !== 'object' || Array.isArray(vocab) || Object.keys(vocab).length < 10) throw new Error('Model vocab is missing or too small')
  const files = []
  for (const filename of MODEL_FILES) files.push(await fileRecord(config.modelDirectory, filename))
  const weight = files.find(({ filename }) => filename === 'pytorch_model.bin')
  if (!weight || weight.bytes < 1_000_000_000) throw new Error('Chinese alignment weight is missing or unexpectedly small')
  if (weight.sha256 !== MODEL_WEIGHT_SHA256) throw new Error(`Chinese alignment weight SHA256 mismatch: ${weight.sha256}`)
  return { files, vocabSize: configJson.vocab_size, samplingRate: preprocessor.sampling_rate }
}

async function verifyNltk(config) {
  const expected = join(config.nltkDirectory, 'tokenizers', 'punkt_tab')
  const info = await stat(expected)
  if (!info.isDirectory()) throw new Error('NLTK punkt_tab directory is not available')
  return expected
}

async function main() {
  const config = argsFrom(process.argv.slice(2))
  for (const [key, value] of Object.entries(config)) {
    if (['install', 'downloadModel', 'downloadNltk', 'verifyOnly'].includes(key)) continue
    if (typeof value === 'string') assertAbsolute(value, key)
  }
  const pythonInfo = await stat(config.pythonPath)
  if (!pythonInfo.isFile()) throw new Error(`Configured Python is not a file: ${config.pythonPath}`)
  const ffmpegInfo = await stat(config.ffmpegPath)
  const ffprobeInfo = await stat(config.ffprobePath)
  if (!ffmpegInfo.isFile() || !ffprobeInfo.isFile()) throw new Error('Configured FFmpeg/ffprobe path is not a file')
  await mkdir(dirname(config.recordPath), { recursive: true })
  const venvPython = join(config.venvDirectory, 'Scripts', 'python.exe')
  if (config.install) await installVenv(config)
  await stat(venvPython)
  if (config.downloadNltk) await downloadNltk(config, venvPython)
  if (config.downloadModel) await downloadModel(config, venvPython)
  const model = await verifyModel(config)
  const nltkPunktTab = await verifyNltk(config)
  const freeze = run(venvPython, ['-m', 'pip', 'freeze', '--all'])
  const pythonVersion = run(venvPython, ['--version']).trim()
  const record = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    pythonPath: config.pythonPath,
    venvPython,
    pythonVersion,
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
    repository: { id: REPO_ID, revision: MODEL_REVISION },
    modelDirectory: config.modelDirectory,
    nltkDirectory: config.nltkDirectory,
    nltkPunktTab,
    model,
    requestedPackages: PACKAGE_VERSIONS,
    pipFreeze: freeze.split(/\r?\n/u).filter(Boolean),
  }
  await writeFile(config.recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
