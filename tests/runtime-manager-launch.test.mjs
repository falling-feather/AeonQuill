import assert from 'node:assert/strict'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile, realpath, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildManagedComfyLaunch } from '../server/runtime-manager.mjs'

test('managed ComfyUI launch keeps runtime code immutable and routes mutable state to data/cache', () => {
  const dataRoot = join('D:\\fixture', 'data')
  const cacheRoot = join('D:\\fixture', 'cache')
  const launch = buildManagedComfyLaunch({ args: ['main.py', '--lowvram'], dataRoot, cacheRoot })
  assert.deepEqual(launch.directories, {
    input: join(dataRoot, 'comfyui', 'input'),
    output: join(dataRoot, 'comfyui', 'output'),
    user: join(dataRoot, 'comfyui', 'user'),
    userDefault: join(dataRoot, 'comfyui', 'user', 'default'),
    temp: join(cacheRoot, 'comfyui', 'temp'),
  })
  for (const [flag, pathname] of [
    ['--input-directory', launch.directories.input],
    ['--output-directory', launch.directories.output],
    ['--user-directory', launch.directories.user],
    ['--temp-directory', launch.directories.temp],
  ]) {
    const index = launch.args.indexOf(flag)
    assert.ok(index > 0)
    assert.equal(launch.args[index + 1], pathname)
  }
})

test('explicit controlled ComfyUI directory arguments are not duplicated', () => {
  const launch = buildManagedComfyLaunch({
    args: ['main.py', '--output-directory', 'D:\\explicit-output'],
    dataRoot: 'D:\\fixture-data',
    cacheRoot: 'D:\\fixture-cache',
  })
  assert.equal(launch.args.filter((value) => value === '--output-directory').length, 1)
  assert.equal(launch.args[launch.args.indexOf('--output-directory') + 1], 'D:\\explicit-output')
})

test('allocator defaults preserve existing arguments and do not inject CUDA settings', () => {
  const args = ['main.py', '--lowvram']
  const launch = buildManagedComfyLaunch({ args })
  assert.equal(launch.allocatorProfile, 'default')
  assert.deepEqual(launch.environment, {})
  assert.equal(launch.args.includes('--disable-cuda-malloc'), false)
  assert.deepEqual(args, ['main.py', '--lowvram'])
})

test('native128 gives only the Comfy child a fixed fragmentation policy', () => {
  const before = { native: process.env.PYTORCH_ALLOC_CONF, legacy: process.env.PYTORCH_CUDA_ALLOC_CONF }
  const launch = buildManagedComfyLaunch({ args: ['main.py'], allocatorProfile: 'native128' })
  assert.equal(launch.allocatorProfile, 'native128')
  assert.equal(launch.args.filter(value => value === '--disable-cuda-malloc').length, 1)
  assert.deepEqual(launch.environment, {
    PYTORCH_ALLOC_CONF: 'backend:native,garbage_collection_threshold:0.6,max_split_size_mb:128',
    PYTORCH_CUDA_ALLOC_CONF: 'backend:native,garbage_collection_threshold:0.6,max_split_size_mb:128',
  })
  assert.deepEqual({ native: process.env.PYTORCH_ALLOC_CONF, legacy: process.env.PYTORCH_CUDA_ALLOC_CONF }, before)
  assert.equal(buildManagedComfyLaunch({ args: ['main.py', '--disable-cuda-malloc'], allocatorProfile: 'native128' }).args.filter(value => value === '--disable-cuda-malloc').length, 1)
})

test('unknown allocator profiles and conflicting explicit flags fail before launch', () => {
  for (const allocatorProfile of ['custom', {}, true]) {
    assert.throws(() => buildManagedComfyLaunch({ args: ['main.py'], allocatorProfile }), error => error.code === 'INVALID_COMFY_ALLOCATOR_PROFILE')
  }
  assert.throws(() => buildManagedComfyLaunch({ args: ['main.py', '--cuda-malloc'], allocatorProfile: 'native128' }), error => error.code === 'COMFY_ALLOCATOR_CONFLICT')
})

test('local configuration selects the same managed allocator policy without modifying parent environment', async t => {
  const parent = resolve('.runtime/qa-temp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'allocator-config-'))
  t.after(async () => {
    assert.ok((await realpath(directory)).startsWith(parent + sep))
    await rm(directory, { recursive: true })
  })
  const config = join(directory, 'local.json')
  await writeFile(config, JSON.stringify({ comfyAllocatorProfile: 'native128', outputDirectory: directory }))
  const moduleUrl = new URL('../server/runtime-manager.mjs', import.meta.url).href
  const script = `import {loadLocalRuntimeConfig,buildManagedComfyLaunch} from ${JSON.stringify(moduleUrl)}; const c=await loadLocalRuntimeConfig(); const launch=buildManagedComfyLaunch({args:c.comfyArgs,allocatorProfile:c.comfyAllocatorProfile}); console.log(JSON.stringify({profile:c.comfyAllocatorProfile,environment:launch.environment,args:launch.args.filter(value=>value==='--disable-cuda-malloc')}));`
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], {
    windowsHide: true, timeout: 10_000,
    env: { ...process.env, AEONQUILL_CONFIG: config, AEONQUILL_DATA_DIR: join(directory, 'UserData') },
  })
  const actual = JSON.parse(result.stdout)
  assert.equal(actual.profile, 'native128')
  assert.deepEqual(actual.args, ['--disable-cuda-malloc'])
  assert.ok(actual.environment.PYTORCH_ALLOC_CONF.includes('max_split_size_mb:128'))
})
