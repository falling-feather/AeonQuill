export type ImageResourceTier = 'thumbnail' | 'preview' | 'original'

const managedAssetPattern = /^\/api\/project-assets\/([a-f0-9]{64})$/
export function managedImageAssetId(source: string) {
  return managedAssetPattern.exec(source)?.[1] ?? null
}
const variantByTier = {
  thumbnail: 'thumbnail-v1',
  preview: 'preview-v1',
} as const

export function resolveImageResource(source: string, requestedTier: ImageResourceTier) {
  if (requestedTier === 'original' || !managedImageAssetId(source)) {
    return { src: source, tier: 'original' as const }
  }
  return {
    src: `${source}?variant=${variantByTier[requestedTier]}`,
    tier: requestedTier,
  }
}
