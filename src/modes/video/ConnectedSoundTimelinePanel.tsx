import { useEffect, useRef, useState } from 'react'
import type { ProcessingJob } from '../../types'
import { flushWorkspaceModeDocument } from '../../lib/projectApi'
import { createSpeechAlignmentJob, waitForSpeechAlignment } from '../../lib/speechAlignmentApi'
import { createSoundRenderJob } from '../../lib/videoApi'
import { SoundTimelinePanel, type SoundTimelinePanelProps, type SpeechAlignmentRequest, type LocalSoundRemixRequest } from './SoundTimelinePanel'

type Props = SoundTimelinePanelProps & { workspaceProjectId?: string; workspaceDocumentId?: string; alignmentJobs: ProcessingJob[]; onJobTracked: (job: ProcessingJob) => void }

export function ConnectedSoundTimelinePanel({ workspaceProjectId, workspaceDocumentId, alignmentJobs, onJobTracked, ...props }: Props) {
  const projectRef = useRef(props.project)
  projectRef.current = props.project
  const requestRef = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => () => requestRef.current?.abort(), [])

  const align = async (input: SpeechAlignmentRequest) => {
    if (!workspaceProjectId || !workspaceDocumentId) throw new Error('请先保存当前智能视频项目')
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setBusy(true)
    try {
      await flushWorkspaceModeDocument(workspaceDocumentId)
      controller.signal.throwIfAborted()
      const current = projectRef.current
      const cue = current.soundTimeline.audioCues.find((entry) => entry.id === input.cueId)
      if (!cue || cue.fingerprint !== input.cueFingerprint || cue.asset?.contentHash !== input.audioContentHash) {
        throw new Error('对白或音频已变化，请重新选择当前片段后对齐')
      }
      const existing = alignmentJobs.slice().sort((left, right) => right.createdAt - left.createdAt).find((job) => (
        job.kind === 'speech-alignment' && ['queued', 'running', 'completed'].includes(job.status)
        && job.request && 'documentId' in job.request && job.request.documentId === workspaceDocumentId
        && job.request.projectId === workspaceProjectId && job.alignmentMetadata?.cueId === cue.id
        && job.alignmentMetadata.cueFingerprint === cue.fingerprint && job.alignmentMetadata.audioContentHash === cue.asset?.contentHash
        && job.alignmentMetadata.language === input.language
      ))
      const job = existing ?? await createSpeechAlignmentJob({
        projectId: workspaceProjectId, documentId: workspaceDocumentId,
        productionRevision: current.revision, soundTimelineRevision: current.soundTimeline.revision,
        cueId: input.cueId, language: input.language,
      }, controller.signal)
      onJobTracked(job)
      return await waitForSpeechAlignment(job.id, controller.signal, onJobTracked)
    } finally {
      if (requestRef.current === controller && !controller.signal.aborted) setBusy(false)
    }
  }

  const remix = async (input: LocalSoundRemixRequest) => {
    if (!workspaceProjectId || !workspaceDocumentId) throw new Error('请先保存当前智能视频项目')
    await flushWorkspaceModeDocument(workspaceDocumentId)
    const current = projectRef.current
    const job = await createSoundRenderJob({
      action: 'render-local', projectId: workspaceProjectId, documentId: workspaceDocumentId,
      productionRevision: current.revision, soundTimelineRevision: current.soundTimeline.revision,
      title: `${current.title} · 局部重混`.slice(0, 120), cueIds: input.cueIds, overlapMs: input.overlapMs,
    })
    onJobTracked(job)
  }

  return <SoundTimelinePanel {...props} alignmentBusy={busy} onRunSpeechAlignment={workspaceProjectId && workspaceDocumentId ? align : undefined} onApplyLocalRemix={workspaceProjectId && workspaceDocumentId ? remix : undefined} />
}
