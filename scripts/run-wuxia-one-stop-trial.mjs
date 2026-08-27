import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { createWorkspaceProject } from '../src/lib/project/projectCatalog.mjs'
import {
  compileStoryProject,
  createGenerationPlan,
} from '../src/lib/story/storyProject.mjs'
import {
  applyVideoProductionCommand,
  createVideoProductionCommand,
  createVideoProductionProjectForStory,
} from '../src/lib/story/productionPipeline.mjs'
import {
  compileConfirmedVideoRequests,
  createExecutionRuntimeSnapshot,
  createVideoExecutionChecklist,
  createVideoExecutionConfirmation,
} from '../src/lib/story/storyExecution.mjs'

const baseUrl = process.env.AEONQUILL_BRIDGE_URL || 'http://127.0.0.1:8787'
const deliveryDirectory = process.env.AEONQUILL_TRIAL_OUTPUT || 'D:\\AEONQUILL\\output'
const runAt = new Date()
const runToken = process.env.AEONQUILL_TRIAL_RUN_TOKEN
  || runAt.toISOString().replace(/[-:TZ.]/gu, '').slice(0, 14)
const workspaceProjectId = `project-wuxia-snow-sword-${runToken}`
const documentId = `document-smart-video-wuxia-${runToken}`
const title = '雪夜问剑 · 光阴砚一站式武侠试片'
let cookie = ''

const storySource = `场景 1：雪夜·荒山竹林与废寺
镜头 1
电影级真人武侠。大雪压暗竹林，废寺灯笼在冷青月色中摇晃。沈砚，二十七岁东亚女剑客，冷白肤色，长黑发高马尾，左眉细疤，墨黑窄袖劲装，深红腰带，银色竹叶发簪，右手握乌鞘长剑，从画面左侧踏雪走向山门。低机位广角缓慢推进，雪粒清晰，真实布料与呼吸白雾，无字幕无水印，保持人物身份与服饰严格一致。
镜头 2
承接上一镜最后姿势和构图。沈砚在破损石阶前停步，右手拇指顶开乌鞘长剑一寸，寒光照亮左眉细疤；远处寺钟无风自鸣，竹影从右向左扫过。中近景轻微环绕，动作克制、重心真实，红腰带与银色竹叶发簪不可变化，无字幕无水印。
镜头 3
承接上一镜末帧。戴哑黑面具的黑衣剑客从右后方竹梢落下，沈砚顺势拔剑转身格挡；两柄剑第一次相撞，火星与雪粉同时迸开。平滑跟拍后小幅横移，清楚呈现双方空间关系，禁止多余肢体、身份漂移和背景跳变，无字幕无水印。
镜头 4
承接上一镜剑刃交击位置。沈砚以乌鞘格开对手剑锋，贴地滑步穿过飘雪，黑衣剑客回身追击；摄影机沿石阶侧向跟拍，近景切入剑刃再回到双人全身，动作连贯、物理重量可信，服饰、发型、面具和光向保持一致，无字幕无水印。
镜头 5
承接上一镜运动方向。沈砚借破旗杆旋身跃起，深红腰带在冷风中划出弧线，一剑挑落黑衣剑客的兵器；时间短暂放缓，月光、火星和雪幕形成高潮画面。受控弧形运镜，面部和手部稳定，不新增人物，不改变废寺布局，无字幕无水印。
镜头 6
承接上一镜落地姿势。东方泛起微蓝晨光，黑衣剑客退入竹雾，沈砚收剑入乌鞘，银色竹叶发簪和左眉细疤仍清晰可见；她独自走过山门，镜头缓慢后拉，寺钟余音与风雪渐弱，留下克制余韵，无字幕无水印。`

function log(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`)
}

async function establishSession() {
  const response = await fetch(`${baseUrl}/api/health`, {
    headers: { origin: baseUrl },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`AEONQUILL health check failed: HTTP ${response.status}`)
  cookie = String(response.headers.get('set-cookie') || '').split(';')[0]
  if (!cookie) throw new Error('AEONQUILL local session cookie was not issued')
}

async function api(pathname, options = {}) {
  const headers = {
    origin: baseUrl,
    cookie,
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...(options.headers || {}),
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `AEONQUILL API ${pathname} returned HTTP ${response.status}`)
    error.code = payload?.error?.code
    error.details = payload?.error?.details
    throw error
  }
  return payload
}

function command(production, type, payload, actor = 'orchestrator') {
  const now = Math.max(Date.now(), production.updatedAt + 1)
  return applyVideoProductionCommand(
    production,
    createVideoProductionCommand(production, type, payload, { actor }),
    { now },
  )
}

function approveProductionNode(production, nodeId, outputSummary) {
  let next = production
  const current = () => next.nodes.find((node) => node.id === nodeId)
  if (current()?.status === 'review') {
    next = command(next, 'node.edit', { nodeId, outputSummary })
  } else if (current()?.status === 'ready' || current()?.status === 'revision') {
    next = command(next, 'node.start', { nodeId })
    next = command(next, 'node.submit-review', { nodeId, outputSummary })
  } else if (current()?.status === 'running' || current()?.status === 'paused') {
    next = command(next, 'node.submit-review', { nodeId, outputSummary })
  }
  if (current()?.status !== 'review') throw new Error(`Production node ${nodeId} did not reach review`)
  return command(next, 'node.approve', { nodeId }, 'user')
}

function smartVideoDocument(project, plan, production) {
  return JSON.stringify({ schemaVersion: 2, project, plan, production })
}

async function saveDocument({ projectId, docId, revision, baseRevision, project, plan, production, reason, forceRecovery = false }) {
  return api(`/api/workspace/documents/${encodeURIComponent(docId)}`, {
    method: 'PUT',
    body: {
      projectId,
      modeId: 'smart-video',
      baseRevision,
      revision,
      value: smartVideoDocument(project, plan, production),
      reason,
      forceRecovery,
    },
  })
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function main() {
  await establishSession()
  log('session.ready', { baseUrl })

  const catalogRecord = await api('/api/workspace/catalog')
  const existingProject = catalogRecord.catalog.projects.find((project) => project.id === workspaceProjectId)
  if (!existingProject) {
    const created = createWorkspaceProject(catalogRecord.catalog, {
      title,
      description: '使用光阴砚智能视频的一站式制片状态机、受控 H3 清单、末帧接力与本地成片任务生成的 30 秒武侠试片。',
      color: 'amber',
      initialModeId: 'smart-video',
      documentTitle: '雪夜问剑 · 30 秒武侠成片',
    }, {
      projectId: workspaceProjectId,
      documentId,
      now: runAt.getTime(),
    })
    await api('/api/workspace/catalog', {
      method: 'PUT',
      body: {
        catalog: created.catalog,
        baseRevision: catalogRecord.catalog.revision,
        source: 'wuxia-one-stop-trial',
      },
    })
    log('workspace.created', { workspaceProjectId, documentId })
  } else {
    if (!existingProject.documents.some((document) => document.id === documentId && document.modeId === 'smart-video')) {
      throw new Error('Existing trial workspace registration does not match the smart-video document')
    }
    log('workspace.reused', { workspaceProjectId, documentId })
  }

  const story = compileStoryProject({
    projectId: documentId,
    title,
    kind: 'script',
    text: storySource,
    aspectRatio: '16:9',
    frameStrategy: 'start-end',
    defaultShotSeconds: 5,
    seed: 20260827,
    now: runAt.getTime(),
  })
  const plan = createGenerationPlan(story, { now: runAt.getTime() })
  const shots = story.scenes.flatMap((scene) => scene.shots)
  if (shots.length !== 6 || shots.some((shot) => shot.durationSeconds !== 5)) {
    throw new Error(`Expected six 5-second shots, received ${shots.length}`)
  }

  let production = createVideoProductionProjectForStory(story, {
    genre: '电影感真人武侠',
    generationMode: 'quality',
    characterMode: 'professional',
    now: runAt.getTime(),
  })
  production = approveProductionNode(production, 'screenwriter', '六镜单场景结构已锁定：雪夜入寺、闻钟戒备、敌手突袭、石阶追剑、挑落兵器、晨光收剑；每镜 5 秒，以动作与空间连续性驱动，无旁白和字幕。')
  production = approveProductionNode(production, 'character-designer', '沈砚身份锁：27 岁东亚女性、冷白肤色、长黑高马尾、左眉细疤、墨黑窄袖劲装、深红腰带、银色竹叶发簪、乌鞘长剑。对手固定哑黑面具与黑衣轮廓；每镜提示词重复关键身份字段。')
  production = approveProductionNode(production, 'art-director', '唯一地点圣经：冷青月色的荒山竹林与废寺石阶；大雪、破灯笼、破旗杆和山门保持空间位置，最终镜由雪夜平滑过渡到微蓝晨光。')
  production = approveProductionNode(production, 'storyboard-director', '已形成 6×5 秒受控分镜：推进—环绕—跟拍—侧移—弧拍—后拉；屏幕方向从左向右建立，后续镜头通过上一镜末帧自动接力。')
  production = approveProductionNode(production, 'asset-producer', '本次试片采用首镜 T2V 建立视觉母版，后五镜由受管视频输出提取末帧并自动作为下一镜 I2V 首帧；所有中间帧和镜头均登记为本地不可变任务资产。')
  production = command(production, 'node.start', { nodeId: 'video-director' })

  await saveDocument({
    projectId: workspaceProjectId,
    docId: documentId,
    revision: 0,
    baseRevision: null,
    project: story,
    plan,
    production,
    reason: 'wuxia-one-stop-before-render',
  })
  log('production.approved', { approvedThrough: 'asset-producer', running: 'video-director' })

  await api('/api/runtime/start', { method: 'POST' })
  const runtimeStatus = await api('/api/runtime/status?refresh=1')
  const runtime = createExecutionRuntimeSnapshot(runtimeStatus)
  const checklist = createVideoExecutionChecklist(story, plan, {
    schemaVersion: 1,
    selections: shots.map((shot) => ({
      shotId: shot.id,
      mode: 'text-to-video',
      frameMode: 'none',
      preset: 'balanced',
      audio: true,
      firstFrameBindingId: null,
      lastFrameBindingId: null,
    })),
  }, {
    now: Date.now(),
    runtime,
    assets: [],
  })
  const readyItems = checklist.items.filter((item) => item.status === 'ready')
  if (readyItems.length !== 6) {
    throw new Error(`Execution checklist blocked ${6 - readyItems.length} shots: ${JSON.stringify(checklist.items.flatMap((item) => item.blocks))}`)
  }
  const confirmation = createVideoExecutionConfirmation(checklist, {
    itemIds: readyItems.map((item) => item.id),
    now: Date.now(),
  })
  const submissions = compileConfirmedVideoRequests(checklist, confirmation, [])
  log('execution.confirmed', {
    checklistId: checklist.id,
    checklistDigest: checklist.digest,
    confirmationDigest: confirmation.digest,
    shots: submissions.length,
    preset: 'balanced',
  })

  const chainPayload = await api('/api/jobs/video-chain', {
    method: 'POST',
    headers: {
      'idempotency-key': `wuxia-chain-${runToken}`,
      'x-miaohui-priority': '35',
    },
    body: {
      projectId: workspaceProjectId,
      title: '雪夜问剑 · 30 秒 720P 成片',
      shots: submissions.map(({ request }) => ({
        ...request,
        duration: 5,
        mode: 'text-to-video',
      })),
      transitionSeconds: 0.12,
      width: 1280,
      height: 720,
      fps: 24,
    },
  })
  const parentJobId = chainPayload.job.id
  log('video-chain.submitted', { parentJobId })

  let lastSignature = ''
  let parentJob
  while (true) {
    parentJob = (await api(`/api/jobs/${encodeURIComponent(parentJobId)}`)).job
    const signature = `${parentJob.status}|${parentJob.phase}|${parentJob.progress}|${parentJob.detail}|${parentJob.activeChildJobId || ''}`
    if (signature !== lastSignature) {
      lastSignature = signature
      log('video-chain.progress', {
        status: parentJob.status,
        phase: parentJob.phase,
        progress: parentJob.progress,
        detail: parentJob.detail,
        activeChildJobId: parentJob.activeChildJobId,
        completedShots: parentJob.childJobIds?.length || 0,
      })
    }
    if (['completed', 'failed', 'cancelled'].includes(parentJob.status)) break
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20_000))
  }
  if (parentJob.status !== 'completed' || !parentJob.outputUrl) {
    throw Object.assign(new Error(parentJob.error?.message || `Video chain ended as ${parentJob.status}`), {
      details: parentJob.error,
    })
  }

  const childJobs = []
  for (const childJobId of parentJob.childJobIds || []) {
    childJobs.push((await api(`/api/jobs/${encodeURIComponent(childJobId)}`)).job)
  }
  const finalCut = (await api(`/api/jobs/${encodeURIComponent(parentJob.finalCutJobId)}`)).job
  production = approveProductionNode(production, 'video-director', `光阴砚一站式连续长片 Job ${parentJobId} 已完成。6 个 H3 镜头 Job：${childJobs.map((job) => job.id).join('、')}。首镜为 T2V，后五镜均由上一镜末帧自动接力 I2V。`)
  production = approveProductionNode(production, 'editor', `本地成片 Job ${finalCut.id} 已按原顺序拼接 6 镜，采用 0.12 秒受控淡化转场，统一到 1280×720 / 24fps / H.264 High / CRF 17。`)
  production = approveProductionNode(production, 'sound-director', `保留 H3 原生声轨；镜间执行 0.12 秒音频交叉淡化，最终进行 -14 LUFS、-1.5 dBTP 限峰与 AAC 48kHz 双声道封装。`)
  production = approveProductionNode(production, 'quality-controller', `媒体质检通过：${finalCut.finalCutMetadata.outputProbe.width}×${finalCut.finalCutMetadata.outputProbe.height}，${finalCut.finalCutMetadata.outputProbe.duration.toFixed(2)} 秒，视频 ${finalCut.finalCutMetadata.outputProbe.videoCodec}，音频 ${finalCut.finalCutMetadata.outputProbe.audioCodec} / ${finalCut.finalCutMetadata.outputProbe.sampleRate}Hz / ${finalCut.finalCutMetadata.outputProbe.channels} 声道。`)

  await saveDocument({
    projectId: workspaceProjectId,
    docId: documentId,
    revision: 1,
    baseRevision: 0,
    project: story,
    plan,
    production,
    reason: 'wuxia-one-stop-render-completed',
    forceRecovery: true,
  })
  await api(`/api/workspace/projects/${encodeURIComponent(workspaceProjectId)}/recovery-points`, {
    method: 'POST',
    body: { documentId, reason: '雪夜问剑一站式成片完成' },
  })

  await mkdir(deliveryDirectory, { recursive: true })
  const finalFilename = `雪夜问剑-AEONQUILL-30s-720p-${runToken}.mp4`
  const finalPath = join(deliveryDirectory, finalFilename)
  const mediaResponse = await fetch(`${baseUrl}${parentJob.outputUrl}`, {
    headers: { origin: baseUrl, cookie },
    cache: 'no-store',
  })
  if (!mediaResponse.ok || !mediaResponse.body) throw new Error(`Final media download failed: HTTP ${mediaResponse.status}`)
  await pipeline(Readable.fromWeb(mediaResponse.body), createWriteStream(finalPath, { flags: 'wx' }))
  const mediaInfo = await stat(finalPath)
  const digest = await sha256File(finalPath)
  const receipt = {
    schemaVersion: 1,
    product: '光阴砚 AEONQUILL',
    pipeline: 'smart-video-one-stop',
    hyperframesUsed: false,
    workspaceProjectId,
    documentId,
    storyProjectId: story.id,
    parentJobId,
    childJobIds: childJobs.map((job) => job.id),
    finalCutJobId: finalCut.id,
    checklistId: checklist.id,
    checklistDigest: checklist.digest,
    confirmationDigest: confirmation.digest,
    modelProfiles: childJobs.map((job) => job.workflowMetadata?.modelProfile),
    presets: childJobs.map((job) => job.request?.preset),
    finalCutMetadata: finalCut.finalCutMetadata,
    finalPath,
    bytes: mediaInfo.size,
    sha256: digest,
    completedAt: Date.now(),
  }
  const receiptPath = join(deliveryDirectory, `雪夜问剑-AEONQUILL-30s-${runToken}-receipt.json`)
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { encoding: 'utf8', flag: 'wx' })
  log('trial.completed', { finalPath, receiptPath, bytes: mediaInfo.size, sha256: digest, duration: finalCut.finalCutMetadata.outputProbe.duration })
}

main().catch((error) => {
  log('trial.failed', { code: error.code, message: error.message, details: error.details })
  process.exitCode = 1
})
