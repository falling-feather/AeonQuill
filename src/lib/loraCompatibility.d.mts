export const LORA_BASE_FAMILIES: readonly ['sd15', 'sdxl', 'flux', 'qwen-image-edit', 'minimax-h3']
export type LoraBaseFamily = (typeof LORA_BASE_FAMILIES)[number]
export type LoraRole = 'style' | 'character'
export type LoraBinding = {
  id: string
  family: LoraBaseFamily
  sha256: string
  role: LoraRole
  strength: number
  clipStrength?: number
  triggerWords?: string[]
}
export type LoraCompatibility = 'compatible' | 'incompatible' | 'unverified'
export type LoraCompatibilityExpectation = {
  family: LoraBaseFamily
  sha256: string
  compatibility: LoraCompatibility
}
export function normalizeLoraBinding(input: unknown): LoraBinding
export function assertLoraBindingCompatible(
  binding: unknown,
  expected: LoraCompatibilityExpectation,
): LoraBinding
