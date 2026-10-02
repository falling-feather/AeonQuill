import {
  applyPixelCommand,
  assertPixelCommand,
  assertPixelDocument,
  migratePixelDocument,
  PixelContractError,
} from './pixelCore.mjs'

const DOCUMENT_SNAPSHOT_KIND = 'document-snapshot'
const DOCUMENT_SNAPSHOT_FIELDS = new Set(['kind', 'document'])

function fail(code, message, details) {
  throw new PixelContractError(code, message, details)
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertRecord(value, path) {
  if (!isRecord(value)) fail('INVALID_OBJECT', `${path} must be an object`, { path })
  return value
}

function assertKnownFields(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('UNKNOWN_FIELD', `${path}.${key} is not allowed`, { path: `${path}.${key}` })
  }
}

function assertHistoryEntry(input) {
  const entry = assertRecord(input, 'historyEntry')
  if (Object.prototype.hasOwnProperty.call(entry, 'kind')) {
    if (entry.kind !== DOCUMENT_SNAPSHOT_KIND) {
      fail('UNKNOWN_HISTORY_ENTRY', `Unsupported history entry kind ${String(entry.kind)}`, { kind: entry.kind })
    }
    assertKnownFields(entry, DOCUMENT_SNAPSHOT_FIELDS, 'historyEntry')
    return entry
  }
  return assertPixelCommand(entry)
}

function nextRevision(revision) {
  if (revision >= Number.MAX_SAFE_INTEGER) {
    fail('REVISION_OVERFLOW', 'Pixel history revision cannot be incremented')
  }
  return revision + 1
}

export function createPixelDocumentHistoryEntry(documentInput) {
  const document = migratePixelDocument(documentInput)
  return {
    kind: DOCUMENT_SNAPSHOT_KIND,
    document,
  }
}

export function applyPixelHistoryEntry(currentDocumentInput, entryInput, commandId) {
  const currentDocument = assertPixelDocument(currentDocumentInput)
  const entry = assertHistoryEntry(entryInput)
  const revision = nextRevision(currentDocument.revision)

  if (entry.kind === DOCUMENT_SNAPSHOT_KIND) {
    const snapshot = migratePixelDocument(entry.document)
    if (snapshot.id !== currentDocument.id) {
      fail('DOCUMENT_ID_MISMATCH', 'History snapshot belongs to a different pixel document', {
        currentId: currentDocument.id,
        snapshotId: snapshot.id,
      })
    }
    const document = snapshot
    document.revision = revision
    assertPixelDocument(document)
    return {
      document,
      inverse: createPixelDocumentHistoryEntry(currentDocument),
    }
  }

  const command = {
    ...entry,
    id: commandId,
    baseRevision: currentDocument.revision,
  }
  return applyPixelCommand(currentDocument, command)
}
