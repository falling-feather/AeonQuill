import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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
const EMBEDDED_IDENTITY_VERSION = 'aeonquill-embedded-build-identity-v1'
const EMBEDDED_IDENTITY_PATH = fileURLToPath(new URL(
  '../.runtime/release/embedded-build-identity.json',
  import.meta.url,
))

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

function identityError(message, { expected = null, actual = null } = {}) {
  return Object.assign(new Error(message), {
    code: 'BUILD_IDENTITY_EMBEDDED_INVALID',
    ...(expected === null ? {} : { expected }),
    ...(actual === null ? {} : { actual }),
  })
}

export function embeddedSourceCommit(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw identityError('内嵌构建身份缺失或格式无效')
  }
  const expected = {
    schemaVersion: EMBEDDED_IDENTITY_VERSION,
    productVersion: PRODUCT_SEMVER,
    functionalTrack: FUNCTIONAL_TRACK,
    buildIdentityVersion: BUILD_IDENTITY_VERSION,
    runtimeRegistryVersion: RUNTIME_REGISTRY_VERSION,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (candidate[key] !== value) {
      throw identityError(`内嵌构建身份的 ${key} 与当前载荷不一致`, {
        expected: value,
        actual: candidate[key],
      })
    }
  }
  const commit = String(candidate.sourceCommit || '').trim().toLocaleLowerCase('en-US')
  if (!COMMIT_PATTERN.test(commit)) throw identityError('内嵌构建提交无效')
  return commit
}

async function packagedIdentity() {
  if (!process.pkg) return null
  try {
    return JSON.parse(await readFile(EMBEDDED_IDENTITY_PATH, 'utf8'))
  } catch (error) {
    throw identityError(`封包载荷无法读取内嵌构建身份：${error.message}`)
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
  embeddedIdentity,
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
  const resolvedEmbeddedIdentity = embeddedIdentity === undefined
    ? await packagedIdentity()
    : embeddedIdentity
  const embeddedCommit = resolvedEmbeddedIdentity === null
    ? null
    : embeddedSourceCommit(resolvedEmbeddedIdentity)
  if (embeddedCommit && configuredCommit && configuredCommit !== embeddedCommit) {
    throw identityError('运行时环境提交与内嵌构建提交不一致', {
      expected: embeddedCommit,
      actual: configuredCommit,
    })
  }
  const sourceCommit = embeddedCommit
    || (COMMIT_PATTERN.test(configuredCommit) ? configuredCommit : await developmentCommit(projectRoot))
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
