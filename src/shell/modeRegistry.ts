import type { ComponentType } from 'react'

export type ProductModeId = 'balanced' | 'pixel' | 'smart-video'

export type ModeMaturity = 'available' | 'preview' | 'planned'

export type ModeAccent = 'amber' | 'blue' | 'violet'

export interface ModeManifest {
  id: ProductModeId
  title: string
  summary: string
  description: string
  maturity: ModeMaturity
  accent: ModeAccent
  runtimeRequirements: readonly string[]
  notice?: string
}

export interface ModeViewProps {
  projectId?: string
  onExit?: () => void
}

export interface ModeModule<
  TProject = unknown,
  TViewProps extends ModeViewProps = ModeViewProps,
> extends ModeManifest {
  createDefaultProject(): TProject
  View: ComponentType<TViewProps>
}

export interface ModeRegistry<TModule extends ModeManifest = ModeManifest> {
  list(): readonly TModule[]
  get(id: ProductModeId): TModule
  has(id: string): id is ProductModeId
}

const PRODUCT_MODE_IDS = ['balanced', 'pixel', 'smart-video'] as const

function isProductModeId(id: string): id is ProductModeId {
  return PRODUCT_MODE_IDS.includes(id as ProductModeId)
}

export function createModeRegistry<TModule extends ModeManifest>(
  modules: readonly TModule[],
): ModeRegistry<TModule> {
  const byId = new Map<ProductModeId, TModule>()

  for (const mode of modules) {
    if (!isProductModeId(mode.id)) {
      throw new Error(`Unknown AEONQUILL mode: ${mode.id}`)
    }
    if (byId.has(mode.id)) {
      throw new Error(`Duplicate AEONQUILL mode: ${mode.id}`)
    }
    byId.set(mode.id, mode)
  }

  for (const id of PRODUCT_MODE_IDS) {
    if (!byId.has(id)) {
      throw new Error(`Missing AEONQUILL mode: ${id}`)
    }
  }

  const ordered = Object.freeze(PRODUCT_MODE_IDS.map((id) => byId.get(id)!))

  return Object.freeze({
    list: () => ordered,
    get: (id: ProductModeId) => {
      const mode = byId.get(id)
      if (!mode) throw new Error(`Mode is not registered: ${id}`)
      return mode
    },
    has: isProductModeId,
  })
}

export const defaultModeManifests = Object.freeze([
  {
    id: 'balanced',
    title: '均衡模式',
    summary: '图像、文字与多模态创作的平衡体验',
    description: '在无限画布中组织素材，衔接图像编辑、像素处理与视频生成。',
    maturity: 'available',
    accent: 'amber',
    runtimeRequirements: ['local-bridge'],
  },
  {
    id: 'pixel',
    title: '像素模式',
    summary: '面向像素艺术与精细图像创作',
    description: '围绕图层、帧、调色板与 Sprite 元数据建立专注工作台。',
    maturity: 'preview',
    accent: 'blue',
    runtimeRequirements: [],
    notice: '图层与动画链路持续完善中',
  },
  {
    id: 'smart-video',
    title: '智能视频',
    summary: '从灵感或剧本开始组织视频创作',
    description: '把人物、场景、镜头与受控的本地图像视频任务串成一条链路。',
    maturity: 'preview',
    accent: 'violet',
    runtimeRequirements: ['local-bridge', 'comfyui', 'video-model'],
    notice: '首轮提供结构化项目与镜头规划骨架',
  },
] satisfies readonly ModeManifest[])

export const defaultModeRegistry = createModeRegistry(defaultModeManifests)
