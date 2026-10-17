const assetVersions = new Map()

export function observeCanvasAssetVersions(projectId, versions) {
  for (const record of versions ?? []) {
    if (typeof record.logicalAssetId !== 'string' || !Number.isSafeInteger(record.version)) continue
    const key = projectId + '\0' + record.logicalAssetId
    assetVersions.set(key, Math.max(assetVersions.get(key) ?? 0, record.version))
  }
}

export function reserveCanvasAssetVersion(projectId, logicalAssetId, currentVersion = 1) {
  const key = projectId + '\0' + logicalAssetId
  const version = Math.max(assetVersions.get(key) ?? 0, currentVersion) + 1
  if (!Number.isSafeInteger(version) || version > 1_000_000) throw new Error('资产版本已达上限')
  assetVersions.set(key, version)
  return version
}

export function canvasLogicalAssetId(element) {
  return typeof element.assetId === 'string' && element.assetId && !/^[a-f0-9]{64}$/u.test(element.assetId)
    ? element.assetId : `asset-${element.id}`
}
