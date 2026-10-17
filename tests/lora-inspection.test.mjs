import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  LORA_MAX_FILE_BYTES,
  inspectLoraFile,
} from '../server/lora-inspection.mjs'

const testRoot = resolve('.runtime', 'tests')

async function withTempDirectory(callback) {
  await mkdir(testRoot, { recursive: true })
  const root = await mkdtemp(join(testRoot, 'lora-inspection-'))
  try {
    return await callback(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function tensorBytes(shape, bytesPerElement) {
  return shape.reduce((total, value) => total * value, bytesPerElement)
}

function makeSafetensors({ metadata = {}, pairs = [], extraTensors = [], dataLengthOverride } = {}) {
  const tensors = {}
  const buffers = []
  let offset = 0
  const addTensor = (name, shape, dtype = 'F16') => {
    const bytesPerElement = dtype === 'F16' || dtype === 'BF16' ? 2 : 4
    const bytes = tensorBytes(shape, bytesPerElement)
    tensors[name] = { dtype, shape, data_offsets: [offset, offset + bytes] }
    buffers.push(Buffer.alloc(bytes))
    offset += bytes
  }
  for (const pair of pairs) {
    addTensor(`${pair.prefix}.lora_A.weight`, [pair.rank, pair.input])
    addTensor(`${pair.prefix}.lora_B.weight`, [pair.output, pair.rank])
  }
  for (const tensor of extraTensors) addTensor(tensor.name, tensor.shape, tensor.dtype)
  const header = Buffer.from(JSON.stringify({ __metadata__: metadata, ...tensors }), 'utf8')
  const data = Buffer.concat(buffers)
  const declaredData = dataLengthOverride === undefined ? data : Buffer.alloc(dataLengthOverride)
  const length = Buffer.alloc(8)
  length.writeBigUInt64LE(BigInt(header.length), 0)
  return Buffer.concat([length, header, declaredData])
}

test('reads a bounded safetensors LoRA, hashes it and infers family from metadata', async () => {
  await withTempDirectory(async (root) => {
    const file = join(root, 'character.safetensors')
    const bytes = makeSafetensors({
      metadata: {
        ss_base_model_version: 'sd_v1',
        ss_network_module: 'networks.lora',
        ss_network_dim: '4',
        ss_network_alpha: '4',
        token_string: 'aeon-character, blue coat',
        unknown_private_field: 'C:\\private\\path',
      },
      pairs: [{ prefix: 'unet', rank: 2, input: 3, output: 4 }],
    })
    await writeFile(file, bytes)
    const result = await inspectLoraFile(file, { allowedRoots: [root], expectedFamily: 'sd15' })
    assert.equal(result.format, 'safetensors')
    assert.equal(result.bytes, bytes.length)
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.equal(result.family, 'sd15')
    assert.deepEqual(result.rank, { min: 2, max: 2 })
    assert.equal(result.tensorCount, 2)
    assert.equal(result.compatibility, 'compatible')
    assert.equal(result.metadata.ss_network_dim, '4')
    assert.equal(result.metadata.token_string, 'aeon-character, blue coat')
    assert.equal(Object.hasOwn(result.metadata, 'unknown_private_field'), false)
    assert.equal(JSON.stringify(result).includes(root), false)
  })
})

test('keeps unknown family unverified and reports family mismatch without trusting expectedFamily', async () => {
  await withTempDirectory(async (root) => {
    const file = join(root, 'unknown.safetensors')
    await writeFile(file, makeSafetensors({
      metadata: { ss_network_module: 'networks.lora' },
      pairs: [{ prefix: 'unet', rank: 1, input: 2, output: 2 }],
    }))
    const unknown = await inspectLoraFile(file, { allowedRoots: [root], expectedFamily: 'sd15' })
    assert.equal(unknown.family, null)
    assert.equal(unknown.compatibility, 'unverified')
    assert.ok(unknown.warnings.includes('LORA_EXPECTED_FAMILY_UNVERIFIED'))

    const mismatch = join(root, 'mismatch.safetensors')
    await writeFile(mismatch, makeSafetensors({
      metadata: { ss_base_model_version: 'sdxl' },
      pairs: [{ prefix: 'unet', rank: 1, input: 2, output: 2 }],
    }))
    const result = await inspectLoraFile(mismatch, { allowedRoots: [root], expectedFamily: 'sd15' })
    assert.equal(result.family, 'sdxl')
    assert.equal(result.compatibility, 'incompatible')
    assert.ok(result.warnings.includes('LORA_FAMILY_MISMATCH'))
  })
})

test('rejects paths outside allowed roots and symlink escapes', async (t) => {
  await withTempDirectory(async (root) => {
    const outsideRoot = await mkdtemp(join(testRoot, 'lora-outside-'))
    try {
      const outside = join(outsideRoot, 'outside.safetensors')
      await writeFile(outside, makeSafetensors({
        metadata: { ss_base_model_version: 'sd_v1' },
        pairs: [{ prefix: 'unet', rank: 1, input: 1, output: 1 }],
      }))
      await assert.rejects(() => inspectLoraFile(outside, { allowedRoots: [root] }), { code: 'LORA_PATH_NOT_ALLOWED' })
      const link = join(root, 'linked.safetensors')
      try {
        await symlink(outside, link, 'file')
      } catch (error) {
        if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) {
          t.skip('当前 Windows 执行环境不允许创建测试符号链接')
          return
        }
        throw error
      }
      await assert.rejects(() => inspectLoraFile(link, { allowedRoots: [root] }), (error) => (
        error?.code === 'LORA_FILE_SYMLINK' || error?.code === 'LORA_PATH_NOT_ALLOWED'
      ))
    } finally {
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })
})

test('rejects malformed tensor bounds, oversized headers and files', async () => {
  await withTempDirectory(async (root) => {
    const overlap = join(root, 'overlap.safetensors')
    const overlapHeader = Buffer.from(JSON.stringify({
      'unet.lora_A.weight': { dtype: 'F16', shape: [1, 1], data_offsets: [0, 2] },
      'unet.lora_B.weight': { dtype: 'F16', shape: [1, 1], data_offsets: [1, 3] },
    }))
    const overlapLength = Buffer.alloc(8)
    overlapLength.writeBigUInt64LE(BigInt(overlapHeader.length), 0)
    await writeFile(overlap, Buffer.concat([overlapLength, overlapHeader, Buffer.alloc(3)]))
    await assert.rejects(() => inspectLoraFile(overlap, { allowedRoots: [root] }), { code: 'LORA_TENSOR_OVERLAP' })

    const oversizedHeader = join(root, 'header.safetensors')
    const headerLength = Buffer.alloc(8)
    headerLength.writeBigUInt64LE(BigInt(4 * 1024 * 1024 + 1), 0)
    await writeFile(oversizedHeader, headerLength)
    await assert.rejects(() => inspectLoraFile(oversizedHeader, { allowedRoots: [root] }), { code: 'LORA_HEADER_TOO_LARGE' })

    const oversizedFile = join(root, 'oversized.safetensors')
    await writeFile(oversizedFile, Buffer.alloc(0))
    await truncate(oversizedFile, LORA_MAX_FILE_BYTES + 1)
    await assert.rejects(() => inspectLoraFile(oversizedFile, { allowedRoots: [root] }), { code: 'LORA_FILE_TOO_LARGE' })
  })
})
