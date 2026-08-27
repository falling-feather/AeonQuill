---
format: 1920x1080
duration: 26s
message: "把灵感、图像、像素与视频收束为一条可控、可恢复的本地优先创作链"
arc: "Future Pacing with feature-benefit progression"
audience: "独立创作者、设计师与本地 AI 工作流用户"
mode: autonomous
music: "restrained cinematic Chinese ink and modern technology underscore, 92 bpm, no vocals"
---

# AEONQUILL 旗舰产品广告

这支视频告诉独立创作者：光阴砚能把散落的创作工具与素材，收束为一条由人掌控、可以持续推进的本地优先工作链。

## Video direction

- **Palette system:** 纸白 `paper` 是所有场景的共同基底；砚黑 `ink` 承担主要文字与结构线；时间蓝 `sun`/`sun-soft` 只用于当前焦点、路径和状态推进；暖金 `ember` 只在品牌落点和关键确认处出现。所有数值严格来自 `frame.md`，不临时添加紫蓝渐变。
- **Typography:** 品牌与诗性句使用 display/serif 角色；功能、状态和标注使用 body/mono 角色。屏幕文字服务 720P 阅读，不复刻网页的小字号。
- **Motion grammar:** 全片采用平滑长尾收束，默认 `power3`；每个元素只在旁白提到它时进入，关键揭示分布在镜头后半段。镜头停住后只允许一次有限的轻微抖动或内部状态变化，不做呼吸缩放。
- **Rhythm:** Frame 1 用单次拉远制造范围感；Frame 2 与 Frame 3 稳定、清晰；Frame 4 是全片最密集的工作状态高潮；Frame 5 在 3.7 秒后进入长时间品牌静止读屏，作为收束与呼吸。
- **Caption keep-out:** 所有标题、焦点和状态卡限制在上方约 83% 的安全区；底部字幕带不承载核心交互。
- **Negative list:** 禁止前 25% 一次性铺满后冻结的幻灯片节奏；禁止所有物体各自漂浮的屏保感；禁止无限循环、随机数、墙钟时间、默认弹跳、后半段无意义慢推；禁止把截图包装成 MiniMax H3 生成镜头。

## Frame 1 — 灵感不再散落

- scene: 极近景墨痕与一束时间蓝光交汇，镜头连续拉远，显露出项目中心与三种创作入口。
- voiceover: "灵感，不该散落在工具之间。"
- duration: 4.2s
- poster: 3.0s
- transition_in: cut
- status: animated
- src: compositions/frames/01-ink-to-workspace.html
- type: hook
- persuasion: Pain validation
- beat: tension → relief
- blueprint: zoom-out-workspace-reveal (Adapt)
- asset_candidates: assets/images/aeon-ink-flow.webp — 品牌水墨流动背景；assets/images/project-center-desktop.png — 真实项目中心桌面界面
- focal: assets/images/project-center-desktop.png
- roles: aeon-ink-flow = background/detail · project-center-desktop = cutout/hero
- sfx: whoosh-cinematic

narrativeRole: 用创作者熟悉的“工具与素材散落”痛点开场，并用完整工作台的显露暗示问题已经有解。

keyMessage: 灵感应该进入一条完整流程，而不是被工具割裂。

Adapt: 保留“一次连续减速拉远并锁定完整工作台”的签名动作；将 6.8 秒模板压缩为 4.2 秒，不使用第二次缩放，墨痕只作为工作台世界中的极近景入口。

Scene 1 (0.0–0.9s): 墨痕纹理与一根暖金时间弧以全幅极近景占满画面，只有“灵感”二字随旁白首词逐字显现；layered-depth 三层，墨痕保持主体而非装饰。时间弧执行一次 SVG self-draw（`svg-path-draw`），世界已在缓慢向外拉。

Scene 2 (0.9–2.8s): 当旁白说到“不该散落”，同一个 `.world` 完成唯一一次强减速 zoom-out（`viewport-change`），墨痕成为项目中心卡片后方的角落笔触，真实项目中心从局部边缘连续显露到约 72% 画幅；无切换、无再推近。

Scene 3 (2.8–4.2s): 镜头完全锁定；“项目 / 三种模式 / 本地运行时”三个细线标注按旁白末段顺序亮起，时间蓝路径把它们连成一体（`dynamic-content-sequencing`），最后 0.6 秒静止读屏。

## Frame 2 — 一砚收束三种创作

- scene: 项目中心作为主舞台，均衡、像素、智能视频三个模式被依次聚光，随后收束到光阴砚品牌标记。
- voiceover: "光阴砚，让图像、像素和视频，汇成一条链。"
- duration: 5s
- poster: 3.3s
- transition_in: zoom-through 0.45s
- status: animated
- src: compositions/frames/02-three-modes.html
- type: product_intro
- persuasion: Rule of three
- beat: clarity + control
- blueprint: device-surface-showcase (Adapt)
- asset_candidates: assets/images/project-center-desktop.png — 真实项目中心桌面界面；assets/images/aeonquill-app-icon.png — 当前桌面应用图标
- focal: assets/images/project-center-desktop.png
- roles: project-center-desktop = cutout/hero · aeonquill-app-icon = supporting/brand anchor
- sfx: click-soft

narrativeRole: 在第二个节拍直接落下价值主张，并用三种模式证明这不是单一功能工具。

keyMessage: 图像、像素与视频在同一个产品内形成可控链路。

Adapt: 保留静态产品表面中“屏幕状态依次推进”的签名；不伪造鼠标点击，只用聚光框和标签在真实项目中心上依次巡览三种入口，摄影机全程固定。

Scene 1 (0.0–1.0s): 应用图标在左上三分点平滑落位，右侧真实项目中心作为宽幅 hero surface 从轻微倾斜恢复正面；asymmetric 20/80、三层深度。只显示“光阴砚”品牌名，与旁白产品名同步。

Scene 2 (1.0–3.7s): “图像 / 像素 / 视频”三枚时间蓝标签依次出现；每个标签出现时，截图中对应模式入口被一枚无遮蔽聚光框点亮，旧标签降为浅色、新标签成为主焦点（`discrete-text-sequence` + `asr-keyword-glow`）。状态间采用同向 cut-the-curve，不移动摄影机。

Scene 3 (3.7–5.0s): 三个标签沿一根横向细线汇聚为“一条链”，应用图标与项目中心保持固定；暖金确认点落在链尾，画面静止约 0.8 秒供 720P 阅读。

## Frame 3 — 资源与工作流跨模式流动

- scene: 左侧资源库资产卡片逐项汇聚，右侧工作流中心显示本地 4060 能力与可选下载；一条时间蓝连线在两者间完成闭环。
- voiceover: "资源与工作流，跨模式复用，随时恢复。"
- duration: 5.2s
- poster: 3.8s
- transition_in: push-slide LEFT 0.4s
- status: animated
- src: compositions/frames/03-library-workflows.html
- type: feature_showcase
- persuasion: Friction reduction
- beat: confidence + ease
- blueprint: comparison-split (Reproduce)
- asset_candidates: assets/images/asset-library-desktop.png — 真实双层资源库界面；assets/images/workflow-center-desktop.png — 真实按需工作流中心界面
- focal: assets/images/asset-library-desktop.png + assets/images/workflow-center-desktop.png
- roles: asset-library-desktop = cutout/equal hero · workflow-center-desktop = cutout/equal hero
- sfx: whoosh-short

narrativeRole: 把“高集成”翻译成对用户直接有用的机制：资产不重复搬运，模型不强制捆绑，项目可恢复。

keyMessage: 创作资产和计算能力都可以按项目组织，而不是一次性消耗。

Reproduce: 直接采用双卡 book-open 对称结构：资源库与工作流中心等权出现，签名动作是两张卡从相反方向以镜像 `rotateY` 展开。

Scene 1 (0.0–0.9s): 上方共享标题“资源 × 工作流”从上向下平滑归位，“跨模式”用时间蓝强调；下方仍留白以等待旁白继续，T 形结构占据上方安全区。

Scene 2 (0.7–2.8s): 左侧资源库、右侧工作流中心从相反翼进入并形成镜像 book-open 倾角（`split-tilt-cards`）；两张真实截图均裁掉无关底部区域，主视觉各占约 42%，相向阴影建立 3D 深度。

Scene 3 (2.8–5.2s): 当旁白说“复用 / 恢复”，内侧两枚附着徽章依次出现：“跨模式复用”“按需启用”；一条更小的恢复点标签随后落在共享中轴。徽章只做一次克制 pop（`spring-pop-entrance`），双卡停止漂移并持稳到结尾。

## Frame 4 — 多智能体工作，但决定权在人

- scene: 智能视频生产台由剧本到分镜、人物、素材、H3 镜头与剪辑依次点亮，进度线推进到审核节点后停住并显出“由你决定”。
- voiceover: "导演、编剧、分镜与剪辑智能体协作；每一步，由你决定。"
- duration: 6.2s
- poster: 4.6s
- transition_in: push-slide LEFT 0.4s
- status: animated
- src: compositions/frames/04-agent-production.html
- type: feature_showcase
- persuasion: Show-don't-tell proof
- beat: power + trust
- blueprint: agent-progress-theater (Adapt)
- asset_candidates: assets/images/production-agent-desktop.png — 真实多智能体制片工作台界面
- focal: assets/images/production-agent-desktop.png
- roles: production-agent-desktop = cutout/hero
- sfx: notification, click

narrativeRole: 展示最复杂的旗舰链路，同时明确智能体受控、可叫停、可修改，避免“黑箱自动化”的不安。

keyMessage: 多智能体负责推进，人始终拥有节点级决定权。

Adapt: 保留“机器工作状态逐步推进并变成可审核收据”的签名；以真实生产台截图为底，不模拟不存在的执行结果，节点光带和审核卡只是对截图内已有状态的视觉强调。

Scene 1 (0.0–1.1s): 真实生产台占据 86% 画幅，轻微透视迅速归正；旁白说“导演、编剧”时，前两个节点的时间蓝轮廓依次点亮，左上角只保留“多智能体制片”小标题。

Scene 2 (1.1–4.4s): “分镜 / 人物 / 剪辑”随着旁白逐项出现为状态短语，细光带沿截图内生产阶段横向推进；每个节点经历“待处理 → 协作中 → 可审核”的有限状态替换（`dynamic-content-sequencing` + `discrete-text-sequence`），一个有限旋转的内部状态环承担工作中指示（`svg-icon-enrichment`），在结果落下时立即停止。

Scene 3 (4.4–6.2s): 截图右侧的人工审批区域被清晰抬升为前景收据卡，“每一步”先出现，“由你决定”随后以暖金确认线写入；一个检查标记完成 SVG self-draw（`svg-path-draw`）。其余界面降到约 55% 对比度，最后 0.9 秒完全静止。

## Frame 5 — 一念落砚，万象成章

- scene: 像素模式中的网格与帧时间线化作粒子，围绕应用图标汇聚；中英品牌语依次落版，最终停留在光阴砚 AEONQUILL 锁定画面。
- voiceover: "以光为墨，以时为卷。一念落砚，万象成章。"
- duration: 5.4s
- poster: 4.2s
- transition_in: blur-crossfade 0.5s
- status: animated
- src: compositions/frames/05-brand-lockup.html
- type: branding
- persuasion: Future pacing
- beat: aspiration + completion
- blueprint: logo-assemble-lockup (Adapt)
- asset_candidates: assets/images/pixel-mode-desktop.png — 真实像素模式桌面界面；assets/images/aeonquill-app-icon.png — 当前桌面应用图标；assets/images/aeon-ink-flow.webp — 品牌水墨流动背景
- focal: assets/images/aeonquill-app-icon.png
- roles: pixel-mode-desktop = supporting/source surface · aeonquill-app-icon = cutout/hero · aeon-ink-flow = background
- sfx: chime, whoosh-cinematic

narrativeRole: 把像素、时间与水墨三个产品符号汇总成品牌记忆，以克制但完整的锁定画面结束。

keyMessage: 光阴砚让一次灵感成为可持续、可交付的作品。

Adapt: 保留“来源元素组装为品牌锁定”的签名；像素网格和时间刻度从真实像素模式中抽离后被图标吸收，最终使用当前应用图标，不手绘替代标志。

Scene 1 (0.0–1.3s): 像素模式截图作为近景源表面占满上方安全区，网格方块与帧刻度沿固定索引从中心向外分层散开（`depth-scatter-assemble`）；背景水墨只在左下形成一次低对比涌动。旁白“以光为墨”以 display 角色逐词落下。

Scene 2 (1.3–3.3s): 网格方块转为时间蓝和暖金短线，围绕中心图标向内归位；应用图标由零到一平滑成形（`spring-pop-entrance` 的无弹跳长尾版本），一圈时间刻度同时完成 SVG self-draw。来源截图在同一中心执行 scale-swap 后退场，不发生硬切。

Scene 3 (3.3–4.3s): 图标轻移左侧，`光阴砚 AEONQUILL` 从其后方向右展开，暖金细线自左向右写入；品牌语“以光为墨，以时为卷。”随旁白完成第一句后显现。

Scene 4 (4.3–5.4s): 第二行“一念落砚，万象成章。”只做一次左到右揭示；所有散落粒子清空，最终锁定居中并完全静止，终帧不淡出。

## Strategy receipt

选择 Future Pacing 是因为产品卖点不是修补单一旧流程，而是建立“本地优先、多模式一体、节点受控”的新创作方式。26 秒采用 5 个节拍：前两镜先完成价值承诺，后三镜只提供与承诺直接相关的证据，避免变成功能清单。
