import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
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
