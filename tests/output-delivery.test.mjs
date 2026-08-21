import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  copyOutputDelivery,
  resolveOutputDeliveryTarget,
} from '../server/output-delivery.mjs'

test('output delivery copies one immutable result into the configured directory', async () => {
  const root = resolve(await mkdtemp(join(tmpdir(), 'aeonquill-output-delivery-')))
  try {
    const managed = join(root, 'managed')
    const output = join(root, 'exports')
    await mkdir(managed, { recursive: true })
    await mkdir(output, { recursive: true })
    const sourcePath = join(managed, 'asset.png')
    await writeFile(sourcePath, Buffer.from([137, 80, 78, 71]))
    const delivered = await copyOutputDelivery({
      sourcePath,
      outputDirectory: output,
      filename: 'image-job-001.png',
    })
    assert.equal(delivered.filename, 'image-job-001.png')
    assert.deepEqual(await readFile(delivered.targetPath), Buffer.from([137, 80, 78, 71]))
    assert.throws(
      () => resolveOutputDeliveryTarget(output, '..\\private.txt'),
      { code: 'INVALID_OUTPUT_DELIVERY_FILENAME' },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
