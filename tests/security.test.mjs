import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertLoopbackBindHost,
  createRestrictedChildEnvironment,
  normalizeAllowedOrigins,
  redactSensitiveText,
  resolveSafeChildPath,
  sanitizePublicPayload,
} from '../server/security.mjs'
import { assertAllowedWorkflow } from '../server/workflow-builder.mjs'

test('bridge binding and origin configuration are loopback only', () => {
  assert.doesNotThrow(() => assertLoopbackBindHost('127.0.0.1'))
  assert.doesNotThrow(() => assertLoopbackBindHost('localhost'))
  assert.throws(() => assertLoopbackBindHost('0.0.0.0'), { code: 'NON_LOOPBACK_BIND_FORBIDDEN' })

  const origins = normalizeAllowedOrigins(8787, ['http://127.0.0.1:4173'])
  assert.equal(origins.has('http://127.0.0.1:8787'), true)
  assert.equal(origins.has('http://127.0.0.1:4173'), true)
  assert.throws(() => normalizeAllowedOrigins(8787, ['https://evil.example']), { code: 'INVALID_ALLOWED_ORIGIN' })
})

test('managed asset resolution rejects traversal, absolute paths, and unknown types', () => {
  const root = process.platform === 'win32' ? 'C:\\runtime\\assets' : '/runtime/assets'
  assert.match(resolveSafeChildPath(root, 'image-safe.png', { extensions: new Set(['.png']) }), /image-safe\.png$/)
  for (const unsafe of ['..%2Fsecret.png', '%2e%2e%5csecret.png', 'C%3A%5csecret.png', 'nested%2Fsecret.png']) {
    assert.throws(() => resolveSafeChildPath(root, unsafe, { extensions: new Set(['.png']) }), { code: 'FORBIDDEN_PATH' })
  }
  assert.throws(() => resolveSafeChildPath(root, 'script.html', { extensions: new Set(['.png']) }), {
    code: 'FORBIDDEN_ASSET_TYPE',
  })
})

test('public error and job data redact credentials and local paths recursively', () => {
  const raw = 'token=super-secret C:\\Users\\person\\project\\input.png Bearer abc.def'
  const redacted = redactSensitiveText(raw)
  assert.doesNotMatch(redacted, /super-secret|C:\\Users|abc\.def/)
  const payload = sanitizePublicPayload({ logs: [{ message: raw }], details: { rawMessage: raw } })
  assert.doesNotMatch(JSON.stringify(payload), /super-secret|C:\\\\Users|abc\.def/)
})

test('public redaction preserves loopback HTTP URLs while still removing drive paths', () => {
  assert.equal(redactSensitiveText('http://127.0.0.1:8188'), 'http://127.0.0.1:8188')
  assert.equal(redactSensitiveText('http://localhost:8795'), 'http://localhost:8795')
  assert.equal(redactSensitiveText('source=C:\\Users\\private\\image.png'), 'source=[local-path]')
})

test('child process environment excludes application secrets', () => {
  const previous = process.env.MIAOHUI_TEST_API_TOKEN
  process.env.MIAOHUI_TEST_API_TOKEN = 'must-not-leak'
  try {
    const environment = createRestrictedChildEnvironment({ U2NET_HOME: 'controlled-model-directory' })
    assert.equal(environment.MIAOHUI_TEST_API_TOKEN, undefined)
    assert.equal(environment.U2NET_HOME, 'controlled-model-directory')
    assert.ok(environment.PATH || environment.Path)
  } finally {
    if (previous === undefined) delete process.env.MIAOHUI_TEST_API_TOKEN
    else process.env.MIAOHUI_TEST_API_TOKEN = previous
  }
})

test('compiled workflows reject unregistered ComfyUI nodes', () => {
  assert.doesNotThrow(() => assertAllowedWorkflow({
    '7': { class_type: 'RandomNoise', inputs: { noise_seed: 1 } },
  }))
  assert.throws(() => assertAllowedWorkflow({
    '1': { class_type: 'ExecuteShellCommand', inputs: { command: 'whoami' } },
  }), { code: 'WORKFLOW_NOT_ALLOWED' })
  assert.throws(() => assertAllowedWorkflow({
    '99': { class_type: 'RandomNoise', inputs: { noise_seed: 1 } },
  }), { code: 'WORKFLOW_NOT_ALLOWED' })
})
