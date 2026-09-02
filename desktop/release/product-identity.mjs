export const PRODUCT_SEMVER = '0.7.1'
export const FUNCTIONAL_TRACK = 'V0.7.24'
export const BUILD_IDENTITY_VERSION = 'aeonquill-build-identity-v1'
export const RUNTIME_REGISTRY_VERSION = 'aeonquill-runtime-registry-v1'

export function releaseIdentityMetadata() {
  return Object.freeze({
    productVersion: PRODUCT_SEMVER,
    functionalTrack: FUNCTIONAL_TRACK,
    buildIdentityVersion: BUILD_IDENTITY_VERSION,
    runtimeRegistryVersion: RUNTIME_REGISTRY_VERSION,
  })
}
