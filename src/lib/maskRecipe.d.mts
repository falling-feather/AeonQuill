import type { MaskRecipe } from '../types'
export function assertMaskRecipe(input: unknown, path?: string, fail?: (code: string, message: string, details?: unknown) => never): MaskRecipe
