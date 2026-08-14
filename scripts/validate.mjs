import { spawn } from 'node:child_process'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const profile = process.argv.includes('--live')
  ? 'live'
  : process.argv.includes('--quick')
    ? 'quick'
    : 'baseline'
const npmInvocation = process.env.npm_execpath
  ? { executable: process.execPath, prefix: [process.env.npm_execpath] }
  : { executable: process.platform === 'win32' ? 'cmd.exe' : 'npm', prefix: process.platform === 'win32' ? ['/d', '/s', '/c', 'npm'] : [] }
const results = []

async function collectMjs(directory) {
  const entries = await readdir(join(projectRoot, directory), { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => join(directory, entry.name))
    .sort()
}

function run(label, executable, args, options = {}) {
  const startedAt = Date.now()
  console.log(`\n=== ${label} ===`)
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd: projectRoot,
      windowsHide: true,
      stdio: 'inherit',
      env: { ...process.env, ...options.env },
    })
    child.once('error', (error) => {
      results.push({ label, status: 'failed', durationMs: Date.now() - startedAt, error: error.message })
      rejectPromise(error)
    })
    child.once('exit', (code, signal) => {
      const durationMs = Date.now() - startedAt
      if (code === 0) {
        results.push({ label, status: 'passed', durationMs })
        resolvePromise()
      } else {
        const error = new Error(`${label} exited with ${signal || code}`)
        results.push({ label, status: 'failed', durationMs, error: error.message })
        rejectPromise(error)
      }
    })
  })
}

async function writeReport(status, error) {
  const reportDirectory = join(projectRoot, '.runtime', 'qa')
  await mkdir(reportDirectory, { recursive: true })
  await writeFile(join(reportDirectory, 'latest.json'), JSON.stringify({
    schemaVersion: 1,
    profile,
    status,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    results,
    error: error?.message,
  }, null, 2), 'utf8')
}

try {
  const syntaxFiles = [...await collectMjs('server'), ...await collectMjs('scripts')]
  for (const file of syntaxFiles) await run(`syntax ${file}`, process.execPath, ['--check', file])
  await run('document metadata and relative links', process.execPath, ['scripts/validate-docs.mjs'])
  await run('unit and offline workflow contracts', npmInvocation.executable, [...npmInvocation.prefix, 'run', 'test:unit'])
  await run('image quality benchmark contract', process.execPath, [
    'scripts/benchmark-image-quality.mjs',
    '--manifest=benchmarks/image-quality/manifest.example.json',
    '--allow-incomplete',
  ])
  await run('TypeScript', npmInvocation.executable, [...npmInvocation.prefix, 'run', 'typecheck'])

  if (profile !== 'quick') {
    await run('production build', npmInvocation.executable, [...npmInvocation.prefix, 'run', 'build'])
    await run('deterministic image processors', process.execPath, ['server/validate-image-tools.mjs'])
    await run('isolated local API', process.execPath, ['scripts/validate-api.mjs'])
    await run('isolated browser smoke', process.execPath, ['scripts/validate-browser.mjs'], {
      env: { MIAOHUI_QA_SKIP_BUILD: '1' },
    })
  }
  if (profile === 'live') {
    await run('live ComfyUI workflow contract', process.execPath, ['server/validate-workflows.mjs'])
  }

  await writeReport('passed')
  console.log(`\n✓ MiaoHui ${profile} validation passed (${results.length} checks)`)
} catch (error) {
  await writeReport('failed', error)
  console.error(`\n✗ MiaoHui ${profile} validation failed: ${error.message}`)
  process.exitCode = 1
}
