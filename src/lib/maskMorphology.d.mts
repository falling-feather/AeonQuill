export type MaskMorphology = {
  expand: number
  feather: number
  trim: number
}

export const DEFAULT_MASK_MORPHOLOGY: Readonly<MaskMorphology>

export function normalizeMaskMorphology(value?: Partial<MaskMorphology>): MaskMorphology

export function applyMaskMorphology(
  alpha: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  value?: Partial<MaskMorphology>,
): Uint8ClampedArray
