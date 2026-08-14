import { randomBytes, timingSafeEqual } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { projectRoot, runtimeDirectory } from './runtime-paths.mjs'

const SESSION_COOKIE = 'miaohui_session'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const SAFE_ENV_KEYS = new Set([
  'APPDATA', 'COMSPEC', 'CONDA_DEFAULT_ENV', 'CONDA_PREFIX', 'HOMEDRIVE', 'HOMEPATH',
  'HOME', 'LANG', 'LC_ALL', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH',
  'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PYTHONHOME', 'PYTHONPATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'TZ',
  'USERPROFILE', 'VIRTUAL_ENV', 'WINDIR', 'XDG_CACHE_HOME',
])
const SAFE_ENV_PREFIXES = [
  'CUDA_', 'HIP_', 'KMP_', 'NVIDIA_', 'OMP_', 'PYTORCH_', 'ROCM_', 'TORCH_', 'VK_', 'VULKAN_',
]
const SENSITIVE_ENV_NAME = /(?:API_?KEY|AUTH|BEARER|COOKIE|CREDENTIAL|PASSWORD|SECRET|SESSION|TOKEN)/i

function securityError(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

function normalizeHostname(value) {
  return String(value || '').trim().replace(/^\[|\]$/g, '').toLowerCase()
}

export function assertLoopbackBindHost(host) {
  if (!LOOPBACK_HOSTS.has(normalizeHostname(host))) {
    throw securityError(500, 'NON_LOOPBACK_BIND_FORBIDDEN', 'MiaoHui local bridge must bind to a loopback host')
  }
}

export function normalizeAllowedOrigins(port, configuredOrigins = []) {
  const candidates = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    ...configuredOrigins,
  ])
  const normalized = new Set()
  for (const candidate of candidates) {
    let url
    try {
      url = new URL(String(candidate))
    } catch {
      throw securityError(500, 'INVALID_ALLOWED_ORIGIN', `Invalid allowed origin: ${candidate}`)
    }
    if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(normalizeHostname(url.hostname))) {
      throw securityError(500, 'INVALID_ALLOWED_ORIGIN', 'Only explicit loopback HTTP(S) origins may call the local bridge')
    }
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      throw securityError(500, 'INVALID_ALLOWED_ORIGIN', 'Allowed origins must not include credentials, paths, queries, or fragments')
    }
    normalized.add(url.origin)
  }
  return normalized
}

function hostHeaderHostname(hostHeader) {
  try {
    return normalizeHostname(new URL(`http://${hostHeader}`).hostname)
  } catch {
    return ''
  }
}

function originFromReferer(value) {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function parseCookie(cookieHeader, name) {
  for (const part of String(cookieHeader || '').split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim()
  }
  return null
}

function constantTimeEqual(left, right) {
  const leftBytes = Buffer.from(String(left || ''), 'utf8')
  const rightBytes = Buffer.from(String(right || ''), 'utf8')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export class LocalBridgeSecurity {
  constructor({ host, port, allowedOrigins = [] }) {
    assertLoopbackBindHost(host)
    this.sessionToken = randomBytes(32).toString('base64url')
    this.allowedOrigins = normalizeAllowedOrigins(port, allowedOrigins)
  }

  applyResponseHeaders(request, response) {
    response.setHeader('content-security-policy', [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "form-action 'self'",
    ].join('; '))
    response.setHeader('cross-origin-opener-policy', 'same-origin')
    response.setHeader('cross-origin-resource-policy', 'same-origin')
    response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('x-frame-options', 'DENY')

    const origin = request.headers.origin
    if (origin && this.allowedOrigins.has(origin)) {
      response.setHeader('access-control-allow-origin', origin)
      response.setHeader('access-control-allow-credentials', 'true')
      response.setHeader('vary', 'Origin')
    }
  }

  assertHost(request) {
    if (!LOOPBACK_HOSTS.has(hostHeaderHostname(request.headers.host))) {
      throw securityError(421, 'HOST_NOT_ALLOWED', 'Request Host is not allowed for the local bridge')
    }
  }

  assertTrustedBrowserSource(request) {
    const origin = request.headers.origin
    if (origin) {
      if (!this.allowedOrigins.has(origin)) {
        throw securityError(403, 'ORIGIN_NOT_ALLOWED', 'Request Origin is not allowed for the local bridge')
      }
      return
    }

    const referer = request.headers.referer
    if (referer) {
      const refererOrigin = originFromReferer(referer)
      if (!refererOrigin || !this.allowedOrigins.has(refererOrigin)) {
        throw securityError(403, 'ORIGIN_NOT_ALLOWED', 'Request referrer is not allowed for the local bridge')
      }
      return
    }

    const fetchSite = String(request.headers['sec-fetch-site'] || '').toLowerCase()
    if (fetchSite === 'cross-site' || fetchSite === 'same-site') {
      throw securityError(403, 'ORIGIN_NOT_ALLOWED', 'Cross-origin browser requests are not allowed for the local bridge')
    }
  }

  handlePreflight(request, response) {
    this.assertHost(request)
    this.assertTrustedBrowserSource(request)
    response.writeHead(204, {
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
    })
    response.end()
  }

  issueSession(response) {
    response.setHeader('set-cookie', `${SESSION_COOKIE}=${this.sessionToken}; Path=/; HttpOnly; SameSite=Strict; Priority=High`)
  }

  requireSession(request) {
    const token = parseCookie(request.headers.cookie, SESSION_COOKIE)
    if (!constantTimeEqual(token, this.sessionToken)) {
      throw securityError(401, 'SESSION_REQUIRED', 'A valid local bridge session is required')
    }
  }
}

export function resolveSafeChildPath(rootDirectory, encodedName, { extensions } = {}) {
  let decodedName
  try {
    decodedName = decodeURIComponent(String(encodedName || ''))
  } catch {
    throw securityError(400, 'INVALID_PATH_ENCODING', 'Asset path encoding is invalid')
  }
  if (
    !decodedName
    || decodedName !== basename(decodedName)
    || isAbsolute(decodedName)
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/.test(decodedName)
  ) {
    throw securityError(403, 'FORBIDDEN_PATH', 'Asset path is outside the managed asset directory')
  }
  if (extensions && !extensions.has(decodedName.slice(decodedName.lastIndexOf('.')).toLowerCase())) {
    throw securityError(403, 'FORBIDDEN_ASSET_TYPE', 'Asset type is not allowed')
  }
  const target = resolve(rootDirectory, decodedName)
  const relativePath = relative(resolve(rootDirectory), target)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw securityError(403, 'FORBIDDEN_PATH', 'Asset path is outside the managed asset directory')
  }
  return target
}

const knownLocalRoots = [projectRoot, runtimeDirectory, homedir(), tmpdir()]
  .filter((value, index, values) => value && values.indexOf(value) === index)
  .sort((left, right) => right.length - left.length)

export function redactSensitiveText(value) {
  let text = String(value ?? '')
  for (const root of knownLocalRoots) {
    text = text.replaceAll(root, '[local-path]').replaceAll(root.replaceAll('\\', '/'), '[local-path]')
  }
  return text
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bmiaohui_session=[^;\s]+/gi, 'miaohui_session=[redacted]')
    .replace(/(\b(?:api[_-]?key|auth(?:orization)?|cookie|credential|password|secret|session|token)\b\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/(?<![a-zA-Z0-9+.-])[a-zA-Z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\\/:*?"<>|\r\n]*/g, '[local-path]')
    .replace(/\\\\[^\\/\s]+[\\/][^\s"'<>|]+/g, '[local-path]')
}

export function sanitizePublicPayload(value, ancestors = new WeakSet()) {
  if (typeof value === 'string') return redactSensitiveText(value)
  if (!value || typeof value !== 'object') return value
  if (ancestors.has(value)) return '[circular]'
  ancestors.add(value)
  if (Array.isArray(value)) {
    const array = value.map((item) => sanitizePublicPayload(item, ancestors))
    ancestors.delete(value)
    return array
  }
  const output = {}
  for (const [key, item] of Object.entries(value)) output[key] = sanitizePublicPayload(item, ancestors)
  ancestors.delete(value)
  return output
}

export function createRestrictedChildEnvironment(overrides = {}) {
  const environment = {}
  for (const [key, value] of Object.entries(process.env)) {
    const upperKey = key.toUpperCase()
    if (SENSITIVE_ENV_NAME.test(upperKey)) continue
    if (SAFE_ENV_KEYS.has(upperKey) || SAFE_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix))) {
      environment[key] = value
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && value !== null) environment[key] = String(value)
  }
  return environment
}
