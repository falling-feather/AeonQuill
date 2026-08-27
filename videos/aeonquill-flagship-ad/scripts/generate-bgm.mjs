#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const output = resolve(process.argv[2] || 'assets/bgm/aeonquill-ink-time.wav')
const duration = Number(process.argv[3] || 26)
const sampleRate = 48_000
const channels = 2
const frames = Math.round(duration * sampleRate)
const pcm = new Int16Array(frames * channels)
const bpm = 92
const beat = 60 / bpm
const seedTimes = [0.7, 4.2, 9.2, 14.4, 20.6, 24.25]
const chordRoots = [146.83, 116.54, 174.61, 130.81, 146.83]
const chordRatios = [1, 1.4983, 2, 2.3784]

let noiseState = 0x4d595df4
let pinkL = 0
let pinkR = 0

function randomSigned() {
  noiseState ^= noiseState << 13
  noiseState ^= noiseState >>> 17
  noiseState ^= noiseState << 5
  return ((noiseState >>> 0) / 0xffffffff) * 2 - 1
}

function triangle(phase) {
  return (2 / Math.PI) * Math.asin(Math.sin(phase))
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function bell(t, start, frequency) {
  const local = t - start
  if (local < 0 || local > 2.8) return 0
  const attack = smoothstep(0, 0.025, local)
  const envelope = attack * Math.exp(-1.65 * local)
  return envelope * (
    Math.sin(2 * Math.PI * frequency * local)
    + 0.48 * Math.sin(2 * Math.PI * frequency * 2.01 * local)
    + 0.19 * Math.sin(2 * Math.PI * frequency * 3.97 * local)
  )
}

function softPulse(t) {
  const local = t % beat
  const envelope = Math.exp(-12 * local)
  return envelope * Math.sin(2 * Math.PI * (52 - local * 9) * local)
}

for (let i = 0; i < frames; i += 1) {
  const t = i / sampleRate
  const segment = Math.min(chordRoots.length - 1, Math.floor((t / duration) * chordRoots.length))
  const root = chordRoots[segment]
  const slow = 0.72 + 0.28 * Math.sin(2 * Math.PI * t / 13.0)
  let pad = 0
  for (let n = 0; n < chordRatios.length; n += 1) {
    const frequency = root * chordRatios[n]
    const phase = 2 * Math.PI * frequency * t + n * 0.71
    pad += (0.031 / (1 + n * 0.34)) * (0.72 * Math.sin(phase) + 0.28 * triangle(phase * 0.5))
  }

  let shimmer = 0
  for (let n = 0; n < seedTimes.length; n += 1) {
    const note = [440, 523.25, 587.33, 659.25, 523.25, 880][n]
    shimmer += 0.038 * bell(t, seedTimes[n], note)
  }

  const rawNoise = randomSigned()
  pinkL = pinkL * 0.996 + rawNoise * 0.004
  pinkR = pinkR * 0.996 + randomSigned() * 0.004
  const airL = pinkL * 0.075
  const airR = pinkR * 0.075
  const pulse = 0.045 * softPulse(t)
  const fade = smoothstep(0, 1.35, t) * (1 - smoothstep(duration - 2.2, duration, t))
  const pan = Math.sin(2 * Math.PI * t / 17) * 0.16
  const common = (pad * slow + shimmer + pulse) * fade
  const left = common * (1 - pan) + airL * fade
  const right = common * (1 + pan) + airR * fade
  pcm[i * 2] = Math.max(-32767, Math.min(32767, Math.round(left * 32767)))
  pcm[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(right * 32767)))
}

const dataBytes = pcm.byteLength
const header = Buffer.alloc(44)
header.write('RIFF', 0)
header.writeUInt32LE(36 + dataBytes, 4)
header.write('WAVE', 8)
header.write('fmt ', 12)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20)
header.writeUInt16LE(channels, 22)
header.writeUInt32LE(sampleRate, 24)
header.writeUInt32LE(sampleRate * channels * 2, 28)
header.writeUInt16LE(channels * 2, 32)
header.writeUInt16LE(16, 34)
header.write('data', 36)
header.writeUInt32LE(dataBytes, 40)

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, Buffer.concat([header, Buffer.from(pcm.buffer)]))
process.stdout.write(`generated ${output} (${duration.toFixed(1)}s, ${sampleRate} Hz stereo)\n`)
