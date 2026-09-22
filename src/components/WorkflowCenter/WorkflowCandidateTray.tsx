import { useEffect, useRef, useState } from 'react'
import type { ProcessingJob } from '../../types'
import { ImageComparison } from '../ImageComparison'

function video(job: ProcessingJob) { return job.outputVersion?.mimeType?.startsWith('video/') ?? false }

export function WorkflowCandidateTray({ jobs }: { jobs: ProcessingJob[] }) {
  const [leftId, setLeftId] = useState('')
  const [rightId, setRightId] = useState('')
  const [layout, setLayout] = useState<'side' | 'slider'>('side')
  const leftVideo = useRef<HTMLVideoElement>(null)
  const rightVideo = useRef<HTMLVideoElement>(null)
  const right = jobs.find(({ id }) => id === rightId) ?? jobs[0]
  const left = jobs.find(({ id }) => id === leftId) ?? jobs[1]
  useEffect(() => {
    leftVideo.current?.pause()
    rightVideo.current?.pause()
  }, [left?.id, right?.id])
  if (!right?.outputUrl) return null
  const options = jobs.map((job, index) => <option key={job.id} value={job.id}>候选 {jobs.length - index} · {job.id.slice(-8)}</option>)
  const bothImages = left && !video(left) && !video(right)
  const playTogether = async () => {
    const videos = [leftVideo.current, rightVideo.current].filter((value): value is HTMLVideoElement => Boolean(value))
    videos.forEach((value) => { value.currentTime = 0 })
    const results = await Promise.allSettled(videos.map((value) => value.play()))
    if (results.some((result) => result.status === 'rejected')) videos.forEach((value) => value.pause())
  }
  return <section className="aq-workflow-candidates" aria-label="工作流候选比较">
    <header><div><h3>候选比较</h3><p>保留最近 20 个完成结果，可并排查看或拖动比较。</p></div>
      {bothImages ? <button type="button" onClick={() => setLayout(layout === 'side' ? 'slider' : 'side')}>{layout === 'side' ? '滑杆对比' : '并排对比'}</button> : null}
      {left && video(left) && video(right) ? <button type="button" onClick={() => void playTogether()}>从头同时播放</button> : null}
    </header>
    <div className="aq-workflow-candidates__selectors">
      <label>比较基准<select aria-label="比较基准" value={left?.id ?? ''} onChange={(event) => setLeftId(event.target.value)}><option value="" disabled>再生成一个候选后比较</option>{options}</select></label>
      <label>当前候选<select aria-label="当前候选" value={right.id} onChange={(event) => setRightId(event.target.value)}>{options}</select></label>
    </div>
    {bothImages && layout === 'slider' && left.outputUrl
      ? <ImageComparison before={left.outputUrl} after={right.outputUrl} beforeLabel="比较基准" afterLabel="当前候选" />
      : <div className="aq-workflow-candidates__media">{[left, right].map((job, index) => job?.outputUrl
        ? <figure key={`${index}:${job.id}`}>{video(job)
          ? <video ref={index === 0 ? leftVideo : rightVideo} src={job.outputUrl} controls preload="metadata" />
          : job.outputVersion?.mimeType?.startsWith('audio/') ? <audio src={job.outputUrl} controls preload="metadata" /> : <img src={job.outputUrl} alt={index === 0 ? '比较基准' : '当前候选'} loading="lazy" />}
          <figcaption><a href={job.outputUrl} target="_blank" rel="noreferrer">打开完整结果</a></figcaption></figure>
        : <div key="empty" className="aq-workflow-center__empty">再次运行同一工作流后，可以比较两个结果。</div>)}</div>}
  </section>
}
