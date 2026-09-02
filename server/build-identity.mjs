import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { basename, dirname } from 'node:path'
import { promisify } from 'node:util'
import {
  BUILD_IDENTITY_VERSION,
  FUNCTIONAL_TRACK,
  PRODUCT_SEMVER,
  RUNTIME_REGISTRY_VERSION,
} from '../desktop/release/product-identity.mjs'

const execFileAsync = promisify(execFile)
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u
const RUNTIME_PACKAGE_PATTERN = /^aeonquill-[a-z0-9][a-z0-9._-]{2,127}$/u

function canonicalIdentity(identity) {
  return JSON.stringify({
    version: identity.version,
    productVersion: identity.productVersion,
    functionalTrack: identity.functionalTrack,
    sourceCommit: identity.sourceCommit,
    runtimePackageId: identity.runtimePackageId,
    runtimeRegistryVersion: identity.runtimeRegistryVersion,
  })
}

async function developmentCommit(projectRoot) {
  if (!projectRoot) return null
  try {
    const { stdout } = await execFileAsync('git.exe', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 2_000,
    })
    const commit = stdout.trim().toLocaleLowerCase('en-US')
    return COMMIT_PATTERN.test(commit) ? commit : null
  } catch {
    return null
  }
}

export function inferRuntimePackageId({ offlineRuntimePackageId, comfyRoot } = {}) {
  if (typeof offlineRuntimePackageId === 'string' && RUNTIME_PACKAGE_PATTERN.test(offlineRuntimePackageId)) {
    return offlineRuntimePackageId
  }
  if (typeof comfyRoot !== 'string' || !comfyRoot) return null
  const candidate = basename(dirname(comfyRoot)).toLocaleLowerCase('en-US')
  return RUNTIME_PACKAGE_PATTERN.test(candidate) ? candidate : null
}

export async function resolveBuildIdentity({
  projectRoot,
  runtimeConfig,
  environment = process.env,
} = {}) {
  const expectedEnvironment = {
    AEONQUILL_PRODUCT_VERSION: PRODUCT_SEMVER,
    AEONQUILL_FUNCTIONAL_TRACK: FUNCTIONAL_TRACK,
    AEONQUILL_BUILD_IDENTITY_VERSION: BUILD_IDENTITY_VERSION,
    AEONQUILL_RUNTIME_REGISTRY_VERSION: RUNTIME_REGISTRY_VERSION,
  }
  for (const [key, expected] of Object.entries(expectedEnvironment)) {
    const actual = String(environment[key] || '').trim()
    if (actual && actual !== expected) {
      throw Object.assign(new Error(`${key} 与当前构建身份不一致`), {
        code: 'BUILD_IDENTITY_MISMATCH',
        expected,
        actual,
      })
    }
  }
  const configuredCommit = String(environment.AEONQUILL_BUILD_COMMIT || '').trim().toLocaleLowerCase('en-US')
  const sourceCommit = COMMIT_PATTERN.test(configuredCommit)
    ? configuredCommit
    : await developmentCommit(projectRoot)
  const runtimePackageId = inferRuntimePackageId(runtimeConfig)
  const identity = {
    version: BUILD_IDENTITY_VERSION,
    productVersion: PRODUCT_SEMVER,
    functionalTrack: FUNCTIONAL_TRACK,
    sourceCommit,
    sourceCommitShort: sourceCommit?.slice(0, 8) ?? null,
    sourceState: sourceCommit ? 'commit' : 'unversioned-development',
    runtimePackageId,
    runtimeRegistryVersion: RUNTIME_REGISTRY_VERSION,
  }
  return Object.freeze({
    ...identity,
    identityHash: createHash('sha256').update(canonicalIdentity(identity)).digest('hex'),
  })
}

export function executionIdentity(buildIdentity) {
  if (!buildIdentity) return null
  return Object.freeze({
    identityHash: buildIdentity.identityHash,
    productVersion: buildIdentity.productVersion,
    functionalTrack: buildIdentity.functionalTrack,
    sourceCommit: buildIdentity.sourceCommit,
    runtimePackageId: buildIdentity.runtimePackageId,
    runtimeRegistryVersion: buildIdentity.runtimeRegistryVersion,
  })
}
