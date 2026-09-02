export const DEFAULT_MASK_MORPHOLOGY = Object.freeze({
  expand: 0,
  feather: 0,
  trim: 0,
})

const MAX_RADIUS = 32
const MAX_PIXELS = 24_000_000

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

export function normalizeMaskMorphology(value = DEFAULT_MASK_MORPHOLOGY) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('mask morphology must be an object')
  }
  const keys = Object.keys(value)
  if (keys.some((key) => !['expand', 'feather', 'trim'].includes(key))) {
    throw new TypeError('mask morphology contains unsupported fields')
  }
  return {
    expand: boundedInteger(value.expand ?? 0, 'expand', -MAX_RADIUS, MAX_RADIUS),
    feather: boundedInteger(value.feather ?? 0, 'feather', 0, MAX_RADIUS),
    trim: boundedInteger(value.trim ?? 0, 'trim', 0, 127),
  }
}

function assertMask(alpha, width, height) {
  if (!(alpha instanceof Uint8Array) && !(alpha instanceof Uint8ClampedArray)) {
    throw new TypeError('alpha must be an 8-bit typed array')
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new RangeError('mask width and height must be positive integers')
  }
  if (width * height > MAX_PIXELS) throw new RangeError(`mask exceeds ${MAX_PIXELS} pixels`)
  if (alpha.length !== width * height) throw new RangeError('alpha length must equal width × height')
}

function extremaLine(source, target, length, stride, offset, radius, maximize) {
  const deque = new Int32Array(length)
  let head = 0
  let tail = 0
  let next = 0
  for (let center = 0; center < length; center += 1) {
    const high = Math.min(length - 1, center + radius)
    while (next <= high) {
      const value = source[offset + next * stride]
      while (tail > head) {
        const previous = source[offset + deque[tail - 1] * stride]
        if (maximize ? value < previous : value > previous) break
        tail -= 1
      }
      deque[tail] = next
      tail += 1
      next += 1
    }
    const low = Math.max(0, center - radius)
    while (head < tail && deque[head] < low) head += 1
    target[offset + center * stride] = source[offset + deque[head] * stride]
  }
}

function morphologyPass(alpha, width, height, radius, maximize) {
  const horizontal = new Uint8ClampedArray(alpha.length)
  const output = new Uint8ClampedArray(alpha.length)
  for (let y = 0; y < height; y += 1) {
    extremaLine(alpha, horizontal, width, 1, y * width, radius, maximize)
  }
  for (let x = 0; x < width; x += 1) {
    extremaLine(horizontal, output, height, width, x, radius, maximize)
  }
  return output
}

function blurLine(source, target, length, stride, offset, radius) {
  let low = 0
  let high = Math.min(length - 1, radius)
  let sum = 0
  for (let index = low; index <= high; index += 1) sum += source[offset + index * stride]
  for (let center = 0; center < length; center += 1) {
    const nextLow = Math.max(0, center - radius)
    const nextHigh = Math.min(length - 1, center + radius)
    while (low < nextLow) {
      sum -= source[offset + low * stride]
      low += 1
    }
    while (high < nextHigh) {
      high += 1
      sum += source[offset + high * stride]
    }
    target[offset + center * stride] = Math.round(sum / (high - low + 1))
  }
}

function boxBlur(alpha, width, height, radius) {
  const horizontal = new Uint8ClampedArray(alpha.length)
  const output = new Uint8ClampedArray(alpha.length)
  for (let y = 0; y < height; y += 1) {
    blurLine(alpha, horizontal, width, 1, y * width, radius)
  }
  for (let x = 0; x < width; x += 1) {
    blurLine(horizontal, output, height, width, x, radius)
  }
  return output
}

export function applyMaskMorphology(alpha, width, height, value = DEFAULT_MASK_MORPHOLOGY) {
  assertMask(alpha, width, height)
  const morphology = normalizeMaskMorphology(value)
  let output = Uint8ClampedArray.from(alpha, (item) => (
    morphology.trim > 0 && item < morphology.trim ? 0 : item
  ))
  if (morphology.expand !== 0) {
    output = morphologyPass(
      output,
      width,
      height,
      Math.abs(morphology.expand),
      morphology.expand > 0,
    )
  }
  if (morphology.feather > 0) {
    output = boxBlur(output, width, height, morphology.feather)
  }
  return output
}
