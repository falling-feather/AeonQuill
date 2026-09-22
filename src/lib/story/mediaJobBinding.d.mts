import type { MediaRunKind } from './mediaSupervisor.mjs'
export type MediaJobBinding = { projectId: string; documentId: string; runId: string; inputFingerprint: string }
export function mediaJobFingerprint(kind: MediaRunKind, input: object): Promise<string>
