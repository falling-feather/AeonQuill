import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clapperboard,
  Clock3,
  Film,
  Image as ImageIcon,
  Layers3,
  Play,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react'
import {
  StoryContractError,
  compileStoryProject,
  createGenerationPlan,
  type FrameStrategy,
  type GenerationPlan,
  type GenerationTaskStage,
  type StoryAspectRatio,
  type StoryProject,
  type StorySourceKind,
} from '../../lib/story/storyProject.mjs'
import './smart-video-workbench.css'

const starterScript = `场景 1：雨夜·旧城书店
镜头 1：全景，雨水沿着老街招牌落下，阿砚推开书店木门。
阿砚：我只想找回被遗忘的那一页。
镜头 2：缓慢推进到柜台，店主把一枚发光的墨锭推到灯下。
店主：写下名字，时间就会替你翻页。

场景 2：黎明·河岸
镜头 1：中景跟拍，阿砚沿河岸奔跑，手中墨锭映出不断变化的旧照片。
镜头 2：特写，阿砚停下，把墨锭按在空白纸面，晨光从纸上铺开。`

export type SmartVideoRuntimeSummary = {
  state: 'offline' | 'starting' | 'ready' | 'busy' | 'error'
  label: string
  detail?: string
}

export type SmartVideoPlanResult = {
  project: StoryProject
  plan: GenerationPlan
}

export type SmartVideoWorkbenchProps = {
  initialText?: string
  initialKind?: StorySourceKind
  runtime?: SmartVideoRuntimeSummary
  onBack?: () => void
  onPlanReady?: (result: SmartVideoPlanResult) => void
}

const stageIcons: Record<GenerationTaskStage, typeof Users> = {
  references: Users,
  frames: ImageIcon,
  videos: Film,
}

function createPreviewPlan(
  text: string,
  kind: StorySourceKind,
  aspectRatio: StoryAspectRatio,
  frameStrategy: FrameStrategy,
): SmartVideoPlanResult {
  const now = Date.now()
  const project = compileStoryProject({
    kind,
    text,
    aspectRatio,
    frameStrategy,
    defaultShotSeconds: 5,
    now,
  })
  return { project, plan: createGenerationPlan(project, { now }) }
}

function errorMessage(error: unknown) {
  if (error instanceof StoryContractError) return `${error.code} · ${error.message}`
  return error instanceof Error ? error.message : '无法解析当前内容'
}

function statusLabel(status: 'needs-reference' | 'reference-planned' | 'ready') {
  if (status === 'ready') return '基准已确认'
  if (status === 'reference-planned') return '基准待生成'
  return '缺少基准'
}

export function SmartVideoWorkbench({
  initialText = starterScript,
  initialKind = 'script',
  runtime = { state: 'offline', label: 'ComfyUI 休眠', detail: '生成阶段才会按策略启动' },
  onBack,
  onPlanReady,
}: SmartVideoWorkbenchProps) {
  const [kind, setKind] = useState<StorySourceKind>(initialKind)
  const [text, setText] = useState(initialText)
  const [aspectRatio, setAspectRatio] = useState<StoryAspectRatio>('16:9')
  const [frameStrategy, setFrameStrategy] = useState<FrameStrategy>('start-end')
  const [result, setResult] = useState<SmartVideoPlanResult>(() =>
    createPreviewPlan(initialText, initialKind, '16:9', 'start-end'),
  )
  const [error, setError] = useState<string | null>(null)
  const [activeSceneId, setActiveSceneId] = useState(result.project.scenes[0]?.id ?? '')

  const activeScene = result.project.scenes.find(({ id }) => id === activeSceneId)
    ?? result.project.scenes[0]
  const shotCount = useMemo(
    () => result.project.scenes.reduce((total, scene) => total + scene.shots.length, 0),
    [result.project.scenes],
  )
  const totalSeconds = useMemo(
    () => result.project.scenes.reduce(
      (total, scene) => total + scene.shots.reduce((sceneTotal, shot) => sceneTotal + shot.durationSeconds, 0),
      0,
    ),
    [result.project.scenes],
  )
  const taskCounts = useMemo(() => new Map(
    result.plan.stages.map((stage) => [
      stage.id,
      result.plan.tasks.filter((task) => task.stage === stage.id).length,
    ]),
  ), [result.plan])

  const compile = () => {
    try {
      const next = createPreviewPlan(text, kind, aspectRatio, frameStrategy)
      setResult(next)
      setActiveSceneId(next.project.scenes[0]?.id ?? '')
      setError(null)
      onPlanReady?.(next)
    } catch (nextError) {
      setError(errorMessage(nextError))
    }
  }

  return (
    <section className="aq-video-workbench" aria-label="智能视频工作台">
      <header className="aq-video-header">
        <div className="aq-video-heading">
          {onBack ? (
            <button type="button" className="aq-video-icon-button" onClick={onBack} aria-label="返回产品主页">
              <ArrowLeft size={18} />
            </button>
          ) : null}
          <span className="aq-video-mode-mark"><Clapperboard size={20} /></span>
          <div>
            <p>AEONQUILL · 智能视频</p>
            <h1>故事编排台</h1>
          </div>
        </div>
        <div className="aq-video-header-status">
          <span className={`aq-video-runtime is-${runtime.state}`}><i />{runtime.label}</span>
          <span className="aq-video-safe-badge"><ShieldCheck size={14} /> Schema 1 · 仅生成计划</span>
        </div>
      </header>

      <div className="aq-video-body">
        <aside className="aq-video-source-panel" aria-label="故事输入">
          <div className="aq-video-panel-title">
            <span><ScrollText size={17} /> 故事源</span>
            <small>{text.length.toLocaleString()} / 60,000</small>
          </div>

          <div className="aq-video-segmented" role="tablist" aria-label="输入类型">
            <button
              type="button"
              role="tab"
              aria-selected={kind === 'idea'}
              className={kind === 'idea' ? 'is-active' : ''}
              onClick={() => setKind('idea')}
            >
              <Sparkles size={15} /> 灵感
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={kind === 'script'}
              className={kind === 'script' ? 'is-active' : ''}
              onClick={() => setKind('script')}
            >
              <Clapperboard size={15} /> 预设剧本
            </button>
          </div>

          <label className="aq-video-script-field">
            <span>{kind === 'idea' ? '描述核心人物、冲突和视觉气质' : '使用“场景 / 镜头 / 角色：对白”组织文本'}</span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              spellCheck={false}
              aria-describedby="aq-video-schema-note"
            />
          </label>

          <div className="aq-video-settings-grid">
            <label>
              <span>画幅</span>
              <select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as StoryAspectRatio)}>
                <option value="16:9">16:9 · 横屏</option>
                <option value="9:16">9:16 · 竖屏</option>
                <option value="1:1">1:1 · 方形</option>
              </select>
            </label>
            <label>
              <span>帧策略</span>
              <select value={frameStrategy} onChange={(event) => setFrameStrategy(event.target.value as FrameStrategy)}>
                <option value="start-end">首帧 + 末帧</option>
                <option value="keyframe">单关键帧</option>
              </select>
            </label>
          </div>

          {error ? (
            <div className="aq-video-error" role="alert">
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          ) : null}

          <button type="button" className="aq-video-compile-button" onClick={compile}>
            <Sparkles size={17} />
            编译故事计划
          </button>

          <div id="aq-video-schema-note" className="aq-video-safety-note">
            <ShieldCheck size={16} />
            <p>
              <strong>安全边界已开启</strong>
              文本模型输出必须通过故事 Schema 与任务白名单；此页面不会调用外部 API，也不会提交任意 ComfyUI JSON。
            </p>
          </div>
        </aside>

        <main className="aq-video-plan-panel">
          <div className="aq-video-plan-summary">
            <div>
              <p>结构化项目</p>
              <h2>{result.project.title}</h2>
            </div>
            <dl>
              <div><dt>场景</dt><dd>{result.project.scenes.length}</dd></div>
              <div><dt>镜头</dt><dd>{shotCount}</dd></div>
              <div><dt>预计时长</dt><dd>{totalSeconds}s</dd></div>
              <div><dt>计划任务</dt><dd>{result.plan.tasks.length}</dd></div>
            </dl>
          </div>

          <section className="aq-video-pipeline" aria-label="任务阶段">
            {result.plan.stages.map((stage, index) => {
              const Icon = stageIcons[stage.id]
              return (
                <div className="aq-video-stage" key={stage.id}>
                  <span><Icon size={18} /></span>
                  <div>
                    <small>阶段 {stage.order}</small>
                    <strong>{stage.label}</strong>
                    <p>{taskCounts.get(stage.id) ?? 0} 个受控任务</p>
                  </div>
                  {index < result.plan.stages.length - 1 ? <ChevronRight className="aq-video-stage-arrow" size={18} /> : null}
                </div>
              )
            })}
          </section>

          <div className="aq-video-plan-grid">
            <section className="aq-video-scenes" aria-label="场景与镜头">
              <div className="aq-video-section-heading">
                <span><Layers3 size={17} /> 分镜结构</span>
                <small>稳定 ID · 可重放</small>
              </div>
              <div className="aq-video-scene-tabs" role="tablist" aria-label="场景">
                {result.project.scenes.map((scene) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={scene.id === activeScene?.id}
                    className={scene.id === activeScene?.id ? 'is-active' : ''}
                    key={scene.id}
                    onClick={() => setActiveSceneId(scene.id)}
                  >
                    <small>{String(scene.ordinal).padStart(2, '0')}</small>
                    <span>{scene.heading}</span>
                  </button>
                ))}
              </div>

              {activeScene ? (
                <div className="aq-video-shot-list">
                  <div className="aq-video-scene-context">
                    <div><span>地点基准</span><code>{activeScene.locationId}</code></div>
                    <p>{activeScene.summary}</p>
                  </div>
                  {activeScene.shots.map((shot) => (
                    <article className="aq-video-shot-card" key={shot.id}>
                      <div className="aq-video-shot-number">{String(shot.ordinal).padStart(2, '0')}</div>
                      <div className="aq-video-shot-content">
                        <div>
                          <h3>{shot.title}</h3>
                          <span><Clock3 size={13} /> {shot.durationSeconds}s</span>
                        </div>
                        <p>{shot.action}</p>
                        <footer>
                          <span>{shot.camera.framing} · {shot.camera.movement}</span>
                          <span>{shot.frameRoles.join(' + ')}</span>
                          <code>{shot.id}</code>
                        </footer>
                      </div>
                    </article>
                  ))}
                </div>
              ) : null}
            </section>

            <aside className="aq-video-continuity" aria-label="一致性资产">
              <div className="aq-video-section-heading">
                <span><Users size={17} /> 一致性基准</span>
                <small>{result.project.characters.length + result.project.locations.length} 项</small>
              </div>
              <div className="aq-video-continuity-group">
                <h3>角色</h3>
                {result.project.characters.length ? result.project.characters.map((character) => (
                  <div className="aq-video-identity-card" key={character.id}>
                    <span className="aq-video-avatar">{character.name.slice(0, 1)}</span>
                    <div><strong>{character.name}</strong><small>{statusLabel(character.consistencyStatus)}</small></div>
                    <CircleDashed size={16} />
                  </div>
                )) : <p className="aq-video-empty">尚未从对白中识别角色，可在后续角色圣经中补充。</p>}
              </div>
              <div className="aq-video-continuity-group">
                <h3>场景</h3>
                {result.project.locations.map((location) => (
                  <div className="aq-video-identity-card" key={location.id}>
                    <span className="aq-video-avatar is-location"><Layers3 size={15} /></span>
                    <div><strong>{location.name}</strong><small>{statusLabel(location.consistencyStatus)}</small></div>
                    <CircleDashed size={16} />
                  </div>
                ))}
              </div>
              <div className="aq-video-runtime-card">
                <div>
                  <span className={`aq-video-runtime-dot is-${runtime.state}`} />
                  <p><strong>{runtime.label}</strong><small>{runtime.detail}</small></p>
                </div>
                <div className="aq-video-runtime-rule">
                  <CheckCircle2 size={15} /> 计划与执行已隔离
                </div>
              </div>
            </aside>
          </div>
        </main>
      </div>

      <footer className="aq-video-footer">
        <div><ShieldCheck size={15} /> 所有任务均绑定受控 workflow ID 与稳定依赖</div>
        <button type="button" disabled title="首轮只生成计划，不执行模型">
          <Play size={15} /> 进入生成队列
        </button>
      </footer>
    </section>
  )
}

export default SmartVideoWorkbench
