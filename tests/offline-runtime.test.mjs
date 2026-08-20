import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  defaultOfflineRuntimeRoot,
  OFFLINE_RUNTIME_PACKAGE_ID,
  offlineRuntimeLayout,
  probeOfflineRuntimePackage,
  sha256File,
} from '../server/offline-runtime.mjs'

test('offline runtime layout stays under the versioned package directory', () => {
  const root = defaultOfflineRuntimeRoot('C:\\runtime-fixture')
  assert.equal(root, join('C:\\runtime-fixture', 'packages', OFFLINE_RUNTIME_PACKAGE_ID))
  const layout = offlineRuntimeLayout(root)
  assert.equal(layout.comfyRoot, join(root, 'ComfyUI'))
  assert.equal(layout.pythonPath, join(root, 'python', 'python.exe'))
})

test('offline runtime probe rejects missing or tampered critical files', async (context) => {
  const base = await mkdtemp(join(tmpdir(), 'aeonquill-runtime-contract-'))
  context.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(base, { recursive: true, force: true })
  })
  const root = defaultOfflineRuntimeRoot(base)
  const layout = offlineRuntimeLayout(root)
  for (const directory of [
    layout.comfyRoot,
    join(root, 'python'),
    join(root, 'tools', 'ffmpeg', 'bin'),
  ]) await mkdir(directory, { recursive: true })
  const files = [
    ['ComfyUI/main.py', 'print("fixture")\n'],
    ['python/python.exe', 'python-fixture'],
    ['tools/ffmpeg/bin/ffmpeg.exe', 'ffmpeg-fixture'],
    ['tools/ffmpeg/bin/ffprobe.exe', 'ffprobe-fixture'],
  ]
  for (const [relativePath, contents] of files) {
    await writeFile(join(root, relativePath), contents)
  }
  const criticalFiles = []
  for (const [relativePath] of files) {
    const pathname = join(root, relativePath)
    const { size } = await import('node:fs/promises').then(({ stat }) => stat(pathname))
    criticalFiles.push({ path: relativePath, bytes: size, sha256: await sha256File(pathname) })
  }
  await writeFile(layout.manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    packageId: OFFLINE_RUNTIME_PACKAGE_ID,
    productVersion: '0.4.0',
    criticalFiles,
  })}\n`)
  assert.equal((await probeOfflineRuntimePackage({ baseRuntimeDirectory: base, verifyCriticalHashes: true }))?.packageId, OFFLINE_RUNTIME_PACKAGE_ID)
  await writeFile(layout.manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    packageId: OFFLINE_RUNTIME_PACKAGE_ID,
    productVersion: '0.4.0',
    criticalFiles: [{ ...criticalFiles[0], path: '../escaped.py' }],
  })}\n`)
  assert.equal(await probeOfflineRuntimePackage({ baseRuntimeDirectory: base, verifyCriticalHashes: true }), null)
  await writeFile(layout.manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    packageId: OFFLINE_RUNTIME_PACKAGE_ID,
    productVersion: '0.4.0',
    criticalFiles,
  })}\n`)
  await writeFile(layout.ffmpegPath, 'tampered')
  assert.equal(await probeOfflineRuntimePackage({ baseRuntimeDirectory: base, verifyCriticalHashes: true }), null)
})
