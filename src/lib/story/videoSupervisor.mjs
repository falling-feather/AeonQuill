import { assertVideoProductionProject } from './productionPipeline.mjs'
import { evaluateMediaSupervisor } from './mediaSupervisor.mjs'

export const VIDEO_SUPERVISOR_DECISION_SCHEMA_VERSION = 1

const TEXT_TURN_NODE_IDS = new Set([
  'screenwriter',
  'character-designer',
  'art-director',
  'storyboard-director',
])

function orderedNodes(project) {
  return project.nodes.slice().sort((left, right) => left.order - right.order)
}

function publicNode(node) {
  return node ? {
    id: node.id,
    order: node.order,
    role: node.role,
    title: node.title,
    purpose: node.purpose,
    adapter: node.adapter,
    status: node.status,
    revision: node.revision,
  } : null
}

function decision(project, status, action, node, message, options = {}) {
  return {
    schemaVersion: VIDEO_SUPERVISOR_DECISION_SCHEMA_VERSION,
    status,
    action,
    node: publicNode(node),
    pendingCardId: options.pendingCardId ?? null,
    modelCallRequired: options.modelCallRequired === true,
    canContinue: options.canContinue === true,
    approvedNodes: project.nodes.filter((item) => item.status === 'approved').length,
    totalNodes: project.nodes.length,
    message,
  }
}

export function evaluateVideoSupervisor(projectInput, options = {}) {
  const project = assertVideoProductionProject(projectInput)
  const nodes = orderedNodes(project)
  const current = nodes.find((node) => node.status !== 'approved') ?? nodes.at(-1) ?? null

  if (project.globalPaused) {
    return decision(project, 'project-paused', 'resume-project', current,
      '全链路已暂停；恢复前督导不会调用模型或推进任何节点。')
  }

  const proposedCard = project.changeCards
    .filter((card) => card.status === 'proposed')
    .sort((left, right) => {
      const leftOrder = nodes.find((node) => node.id === left.nodeId)?.order ?? Number.MAX_SAFE_INTEGER
      const rightOrder = nodes.find((node) => node.id === right.nodeId)?.order ?? Number.MAX_SAFE_INTEGER
      return leftOrder - rightOrder || left.createdAt - right.createdAt
    })[0]
  if (proposedCard) {
    const node = nodes.find((item) => item.id === proposedCard.nodeId) ?? current
    return decision(project, 'change-card-review', 'review-change-card', node,
      `“${proposedCard.title}”正在等待用户处理；督导不会叠加新提案。`, {
        pendingCardId: proposedCard.id,
      })
  }

  const review = nodes.find((node) => node.status === 'review')
  if (review) {
    return decision(project, 'node-review', 'review-node', review,
      `${review.title}已有待审批产物；用户批准或退回前不会继续。`)
  }

  const failed = nodes.find((node) => node.status === 'failed')
  if (failed) {
    return decision(project, 'node-failed', 'reset-node', failed,
      `${failed.title}处于失败状态；请先检查错误并由用户决定是否重置。`)
  }

  const paused = nodes.find((node) => node.status === 'paused')
  if (paused) {
    return decision(project, 'node-paused', 'resume-node', paused,
      `${paused.title}已由用户暂停；恢复前督导不会继续。`)
  }

  const mediaDecision = evaluateMediaSupervisor(project, options)
  if (mediaDecision.status !== 'none') {
    const mediaNode = mediaDecision.run ? nodes.find((item) => item.id === mediaDecision.run.nodeId) ?? current : current
    return decision(project, mediaDecision.status, mediaDecision.action, mediaNode, mediaDecision.message, {
      canContinue: mediaDecision.canContinue,
    })
  }

  const active = nodes.find((node) => node.status === 'running')
    ?? nodes.find((node) => node.status === 'ready' || node.status === 'revision')
  if (active) {
    if (TEXT_TURN_NODE_IDS.has(active.id)) {
      return decision(project, 'text-turn-ready', 'compose-text-turn', active,
        `督导可为${active.title}生成一轮只读文本计划，并在共享审批面停下。`, {
          modelCallRequired: true,
          canContinue: true,
        })
    }
    return decision(project, 'runtime-required', 'open-runtime', active,
      `${active.title}必须消费真实资产、运行时或人工质量事实；文本模型不得伪造完成。`, {
        canContinue: true,
      })
  }

  if (nodes.every((node) => node.status === 'approved')) {
    return decision(project, 'completed', 'none', nodes.at(-1) ?? null,
      '全部生产节点已批准；督导不会再创建计划。')
  }

  return decision(project, 'dependency-blocked', 'resolve-dependency', current,
    '当前没有可运行节点；请检查上游审批、连续性资产、声音或交付门。')
}

export function isVideoSupervisorTextNode(nodeId) {
  return TEXT_TURN_NODE_IDS.has(nodeId)
}
