import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

export const fakeComfyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIACQFe3gAAAABJRU5ErkJggg==',
  'base64',
)

const defaultObjectInfo = {
  CLIPTextEncode: { input: { required: { text: ['STRING', {}] } } },
  SaveImage: { input: { required: {} } },
}

function json(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

async function bodyJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

export async function startFakeComfyRuntime({
  objectInfo = defaultObjectInfo,
  output = { kind: 'image', filename: 'custom-result.png', mimeType: 'image/png', bytes: fakeComfyPng },
  runtime = {},
} = {}) {
  const prompts = new Map()
  const sockets = new Set()
  let promptSequence = 0
  let interrupted = 0
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/system_stats') {
      return json(response, 200, {
        system: {
          comfyui_version: runtime.comfyVersion || '0.30.2',
          python_version: runtime.pythonVersion || '3.12.0',
          pytorch_version: runtime.pytorchVersion || '2.9.0+cu130',
          ram_total: 32 * 1024 ** 3,
          ram_free: 24 * 1024 ** 3,
        },
        devices: [{ name: runtime.device || 'Fake RTX 4060', vram_total: 8 * 1024 ** 3, vram_free: 7 * 1024 ** 3 }],
      })
    }
    if (request.method === 'GET' && url.pathname === '/object_info') return json(response, 200, objectInfo)
    if (request.method === 'GET' && url.pathname === '/queue') {
      const running = [...prompts.values()]
        .filter(({ status }) => status === 'running')
        .map(({ id }) => [0, id])
      return json(response, 200, { queue_running: running, queue_pending: [] })
    }
    if (request.method === 'POST' && url.pathname === '/prompt') {
      const payload = await bodyJson(request)
      const id = `fake-prompt-${++promptSequence}`
      const prompt = String(payload.prompt?.['1']?.inputs?.text || '')
      prompts.set(id, {
        id,
        prompt,
        workflow: payload.prompt,
        status: prompt.includes('wait-cancel') ? 'running' : 'completed',
      })
      return json(response, 200, { prompt_id: id, number: promptSequence })
    }
    const historyMatch = /^\/history\/([^/]+)$/u.exec(url.pathname)
    if (request.method === 'GET' && historyMatch) {
      const id = decodeURIComponent(historyMatch[1])
      const record = prompts.get(id)
      if (!record) return json(response, 200, {})
      const outputs = record.prompt.includes('missing-output')
        ? { 99: { images: [{ filename: 'wrong-node.png', subfolder: '', type: 'output' }] } }
        : output.kind === 'video'
          ? { 99: { videos: [{ filename: output.filename, subfolder: '', type: 'output' }] } }
          : { 2: { images: [{ filename: output.filename, subfolder: '', type: 'output' }] } }
      return json(response, 200, {
        [id]: {
          status: { completed: record.status === 'completed', messages: [] },
          outputs: record.status === 'completed' ? outputs : {},
        },
      })
    }
    if (request.method === 'GET' && url.pathname === '/view') {
      response.writeHead(200, { 'content-type': output.mimeType, 'content-length': output.bytes.length })
      response.end(output.bytes)
      return
    }
    if (request.method === 'POST' && url.pathname === '/upload/image') {
      for await (const _chunk of request) {
        // The fixture only needs to consume the bounded multipart body.
      }
      return json(response, 200, { name: 'fixture-upload.png', subfolder: '', type: 'input' })
    }
    if (request.method === 'POST' && url.pathname === '/interrupt') {
      interrupted += 1
      for (const record of prompts.values()) {
        if (record.status === 'running') record.status = 'interrupted'
      }
      return json(response, 200, {})
    }
    if (request.method === 'POST' && ['/queue', '/free'].includes(url.pathname)) return json(response, 200, {})
    return json(response, 404, { error: 'not found' })
  })

  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key']
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'))
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    prompts,
    get interrupted() { return interrupted },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
