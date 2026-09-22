import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  executionIdentity,
  embeddedSourceCommit,
  inferRuntimePackageId,
  resolveBuildIdentity,
} from '../server/build-identity.mjs'
import { JobStore } from '../server/job-store.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const testRoot = join(projectRoot, '.runtime', 'tests')
const sourceCommit = '4'.repeat(40)

test('build identity binds product, functional track, source commit and runtime package', async () => {
  const runtimePackageId = 'aeonquill-comfyui-h3-cu130-win-x64-v2'
  const identity = await resolveBuildIdentity({
    runtimeConfig: { comfyRoot: join('D:\\AEONQUILL-Package', 'runtime-candidates', runtimePackageId, 'ComfyUI') },
    environment: {
      AEONQUILL_BUILD_COMMIT: sourceCommit,
      AEONQUILL_PRODUCT_VERSION: '0.7.1',
      AEONQUILL_FUNCTIONAL_TRACK: 'V0.7.82',
      AEONQUILL_BUILD_IDENTITY_VERSION: 'aeonquill-build-identity-v1',
      AEONQUILL_RUNTIME_REGISTRY_VERSION: 'aeonquill-runtime-registry-v1',
    },
  })

  assert.equal(identity.productVersion, '0.7.1')
  assert.equal(identity.functionalTrack, 'V0.7.82')
  assert.equal(identity.sourceCommit, sourceCommit)
  assert.equal(identity.sourceCommitShort, sourceCommit.slice(0, 8))
  assert.equal(identity.runtimePackageId, runtimePackageId)
  assert.match(identity.identityHash, /^[a-f0-9]{64}$/u)
  assert.deepEqual(executionIdentity(identity), {
    identityHash: identity.identityHash,
    productVersion: '0.7.1',
    functionalTrack: 'V0.7.82',
    sourceCommit,
    runtimePackageId,
    runtimeRegistryVersion: 'aeonquill-runtime-registry-v1',
  })
})

test('packaged build identity uses an immutable embedded commit and rejects drift', async () => {
  const embeddedIdentity = {
    schemaVersion: 'aeonquill-embedded-build-identity-v1',
    productVersion: '0.7.1',
    functionalTrack: 'V0.7.82',
    buildIdentityVersion: 'aeonquill-build-identity-v1',
    runtimeRegistryVersion: 'aeonquill-runtime-registry-v1',
    sourceCommit,
  }
  assert.equal(embeddedSourceCommit(embeddedIdentity), sourceCommit)
  const identity = await resolveBuildIdentity({ environment: {}, embeddedIdentity })
  assert.equal(identity.sourceCommit, sourceCommit)
  assert.equal(identity.sourceState, 'commit')
  await assert.rejects(
    resolveBuildIdentity({
      environment: { AEONQUILL_BUILD_COMMIT: '5'.repeat(40) },
      embeddedIdentity,
    }),
    (error) => error.code === 'BUILD_IDENTITY_EMBEDDED_INVALID'
      && error.expected === sourceCommit
      && error.actual === '5'.repeat(40),
  )
})

test('build identity rejects a shell/product mismatch instead of silently drifting', async () => {
  await assert.rejects(
    resolveBuildIdentity({
      environment: {
        AEONQUILL_BUILD_COMMIT: sourceCommit,
        AEONQUILL_PRODUCT_VERSION: '9.9.9',
      },
    }),
    (error) => error.code === 'BUILD_IDENTITY_MISMATCH'
      && error.expected === '0.7.1'
      && error.actual === '9.9.9',
  )
  assert.equal(inferRuntimePackageId({ comfyRoot: 'D:\\unmanaged\\ComfyUI' }), null)
})

test('new jobs persist the execution identity that created them', async (t) => {
  await mkdir(testRoot, { recursive: true })
  const directory = await mkdtemp(join(testRoot, 'build-identity-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const jobPath = join(directory, 'jobs.json')
  const stamp = {
    identityHash: 'a'.repeat(64),
    productVersion: '0.7.1',
    functionalTrack: 'V0.7.82',
    sourceCommit,
    runtimePackageId: null,
    runtimeRegistryVersion: 'aeonquill-runtime-registry-v1',
  }
  const store = new JobStore(jobPath, { getExecutionIdentity: () => stamp })
  await store.load()
  await store.add({ id: 'job-identity', createdAt: 1, status: 'queued' })
  assert.deepEqual(store.get('job-identity').executionIdentity, stamp)
  const persisted = JSON.parse(await readFile(jobPath, 'utf8'))
  assert.deepEqual(persisted[0].executionIdentity, stamp)
})
