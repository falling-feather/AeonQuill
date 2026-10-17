import { PixelComputationClient } from './pixelComputationClient.mjs'
import { serializePixelDocument } from './pixelCore.mjs'

let sequence = 0
const activeSerializations = new Map()

export async function serializePixelDocumentOffThread(document) {
  activeSerializations.get(document.id)?.dispose()
  activeSerializations.delete(document.id)
  if (document.width * document.height * document.frames.length * document.layers.length < 262_144) {
    return serializePixelDocument(document)
  }
  const client = new PixelComputationClient()
  activeSerializations.set(document.id, client)
  try {
    const result = await client.run({
      requestId: `pixel-persistence-${++sequence}`,
      documentId: document.id,
      revision: document.revision,
      operation: 'document-json',
      document,
      options: { budgetBytes: 256 * 1024 * 1024 },
    })
    if (typeof result !== 'string') throw new Error('像素保存响应无效，草稿仍保留')
    return result
  } finally {
    if (activeSerializations.get(document.id) === client) activeSerializations.delete(document.id)
    client.dispose()
  }
}
