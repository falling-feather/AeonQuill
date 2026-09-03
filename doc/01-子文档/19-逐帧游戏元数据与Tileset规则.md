# 光阴砚 AEONQUILL — 逐帧游戏元数据、Terrain Map、引擎交付与跨帧选区

> 该文档隶属于[01-开发者文档第 6 节](../01-开发者文档.md#6-模块实现)，用于补充像素逐帧锚点、碰撞区、地形位掩码、持久化 Terrain Map、调色板循环、动画事件、游戏交付及跨帧选区编辑的可复核事实。
>
> **文档梗概**：说明 `PIXEL-006 / V0.7.42` 建立的 PixelDocument schema v4、逐帧游戏元数据与 Tiled 交付，`PIXEL-007 / V0.7.43` 升级的 schema v5、无修订污染调色板循环、片段内动画事件和唯一基础帧活动片段包，`PIXEL-008 / V0.7.44` 建立的确定性 Terrain 九宫格推断、预览和 PNG/JSON 交付，`PIXEL-009 / V0.7.45` 建立的 Godot 4、Unity 2021.2+ 与 RPG Maker MZ 同源桥接包，`PIXEL-010 / V0.7.46` 建立的严格内存选区剪贴板与跨帧、跨图层原子粘贴，`PIXEL-011 / V0.7.47` 建立的 schema v6 持久化任意尺寸 Terrain Map，以及 `PIXEL-012 / V0.7.48` 建立的 schema v7 逐格多 Terrain 编排、切换画笔与多 WangSet 交付。
>
> **最后一次更新时间**：2026-09-03
>
> **更新者**：主开发、像素模式责任域、前端与游戏资产责任域
>
> **对应检查点**：`PIXEL-006 / V0.7.42`、`PIXEL-007 / V0.7.43`、`PIXEL-008 / V0.7.44`、`PIXEL-009 / V0.7.45`、`PIXEL-010 / V0.7.46`、`PIXEL-011 / V0.7.47`、`PIXEL-012 / V0.7.48`

---

## 1. 能力边界

本检查点把过去由游戏导出参数临时推导的单一锚点，升级为每一帧都可保存和编辑的正式游戏元数据。锚点、碰撞区和 Tileset 规则不是 UI 草稿，也不是只存在于某个引擎模板里的二次数据；它们属于唯一权威 `PixelDocument`，通过 `frames.patch` 原子修改，并由项目、Sprite metadata、游戏 manifest、Tiled TSJ/TMJ 与离线查看器共同消费。

当前提供：

- 每帧一个整数锚点，允许位于像素矩形内部或右/下边界；
- 每帧最多八个具名轴对齐矩形碰撞区；
- `solid`、`hitbox`、`hurtbox`、`interaction` 四种固定碰撞语义；
- 每帧可选一个 Terrain ID 与 8 邻域位掩码；
- 画布中可开关的锚点十字和按类型着色的碰撞区叠加；
- 复制帧时复制独立元数据，空白帧使用安全默认；
- Tiled tile object group 与 mixed WangSet，以及离线可视预览。

`PIXEL-006` 本身不提供任意多边形/圆形碰撞、嵌套碰撞层、基于像素轮廓的自动碰撞生成、Dual-grid 推导、动画事件、引擎导入器或双向编辑；后续 `PIXEL-007` 已补入动画事件，`PIXEL-009` 已补入单向引擎桥接。任意碰撞、Dual-grid 和编辑器双向回写仍未实现。

## 2. PixelDocument schema v4

每个 `PixelFrame` 新增必填 `gameplay`：

```ts
type PixelFrameGameplay = {
  anchor: { x: number; y: number }
  collisions: Array<{
    id: string
    name: string
    type: 'solid' | 'hitbox' | 'hurtbox' | 'interaction'
    x: number
    y: number
    width: number
    height: number
  }>
  tileRule: {
    terrainId: string
    bitmask: number
  } | null
}
```

几何坐标全部使用当前帧原始像素空间，不跟随工作台 CSS 缩放。锚点 `x`/`y` 分别允许 `0—document.width` 与 `0—document.height`，因此角色脚底可以落在图像下边界；碰撞区左上角必须在图像内部，宽高至少为 1，右下边界不得越出图像。碰撞 ID 在单帧内唯一，名称长度为 1—48，未知字段、未知类型、重复 ID、越界或第九个碰撞区均失败关闭。

空白帧默认值固定为：

```js
{
  anchor: { x: Math.floor(width / 2), y: height },
  collisions: [],
  tileRule: null,
}
```

## 3. 8 邻域规则

`tileRule.bitmask` 是 `0—255` 的整数，位序与 Tiled Wang ID 顺序一致：

| 邻居 | 位值 | Wang ID 位置 |
| --- | ---: | ---: |
| 北 | 1 | 0 |
| 东北 | 2 | 1 |
| 东 | 4 | 2 |
| 东南 | 8 | 3 |
| 南 | 16 | 4 |
| 西南 | 32 | 5 |
| 西 | 64 | 6 |
| 西北 | 128 | 7 |

UI 以当前图块为中心显示 3×3 邻域；点击邻居只对相应位执行 XOR，不重排帧或自动生成缺失图块。相同 `terrainId` 的帧在 TSJ 中归入同一个 `type: mixed` WangSet，`colors` 保存单一地形颜色定义，`wangtiles[].wangid` 严格由上述八位转换。该结构遵循当前 Tiled JSON Map Format 对 Wang Set 的 `colors`、`type` 和八项 `wangid` 约定。

## 4. 命令、帧生命周期与迁移

游戏元数据复用现有 `frames.patch`，补丁携带完整 `gameplay` 候选。核心在写入前校验完整候选，成功后生成包含旧值的同类型逆命令，因此一次锚点修改、碰撞增删改或邻域切换都对应一个 revision 和一个撤销单元。

帧生命周期固定为：

1. `frames.add + copyFromFrameId` 深复制源帧 Cel 与 `gameplay`，新旧帧不共享对象引用；
2. 不指定复制源的 `frames.add` 使用安全默认；
3. `frames.remove` 的内部恢复载荷保存完整帧，因此撤销删除会恢复游戏元数据；
4. Sprite 和游戏导出只读取已通过 `assertPixelDocument()` 的当前正文。

迁移路径为：

- schema v4：严格校验后复制；
- schema v3：保留图层组/混合/动画，在每帧补安全默认游戏元数据；
- schema v2：补图层组/混合和游戏元数据；
- schema v1：再补动画标签；
- schema v0：经既有单层调色板迁移器创建完整 v4 文档；
- 缺失或未知版本：拒绝导入。

迁移只创建新内存文档，不覆盖原始项目文件。

## 5. UI 与画布叠加

右侧“游戏元数据”检查器始终绑定当前活动帧：

- 锚点 X/Y 使用受文档尺寸约束的整数输入；
- 碰撞区可添加、改名、切换类型、编辑 X/Y/W/H 或删除；
- Tileset 可逐帧启停，编辑 Terrain ID，并切换八个邻居；
- 当前 Mask 十进制值与帧名同时可见。

中央画布在 RGBA 正文和洋葱皮完成后绘制辅助层：实体、攻击、受击和交互区使用不同颜色，锚点使用紫色十字。辅助层只用于编辑观察，不进入 Sprite PNG；顶部“游戏辅助线”可隐藏显示，但不修改正文和 revision。动画播放时叠加跟随正在预览的帧，检查器仍只编辑活动帧，避免预览游标污染项目状态。

## 6. 六文件同源交付

游戏资产包继续输出六项：

1. `.aeonpixel.json`：完整 PixelDocument schema v4；
2. `-sprite-sheet.png`：核心 RGBA 合成后的像素 Atlas；
3. `-game-manifest.json`：每帧 Atlas、时长、锚点、碰撞区和地形规则；
4. `-tileset.tsj`：每个 tile 的属性、碰撞 `objectgroup` 与 Terrain WangSet；
5. `-tilemap.tmj`：引用同一 TSJ，并复用 manifest 的 GID 布局；
6. `-preview.html`：只读取同目录 Sprite，叠加锚点/碰撞并显示 Terrain/Mask，不访问外部网络。

Sprite metadata 同步升级为 schema v4，并在每个布局单元附带该帧 `gameplay`。辅助元数据不会改变 Sprite 像素尺寸或顺序；TSJ/TMJ 和查看器也不会另行猜测碰撞或 Terrain。

## 7. 验证口径

自动契约覆盖：

- schema v0/v1/v2/v3→v4 迁移、v4 无损往返和固定转换哈希；
- 默认锚点、逐帧补丁逆命令、复制帧深复制与空白帧默认；
- 锚点、碰撞数量/ID/类型/边界、Terrain ID/Mask 和额外字段失败关闭；
- Sprite metadata、manifest、Tiled object group、mixed WangSet 与离线查看器同源；
- 全仓 279/279 单元契约、96 项默认安全基线、TypeScript 和生产构建。

P7 在 D 盘隔离项目和后台系统 Edge 中，把活动帧锚点改为 `(6, 16)`，建立名为“剑锋”的 `hitbox`，启用 `wuxia-floor` 并切换北/东邻居得到 `Mask 5`。六个实际下载文件被逐项读取：项目与 manifest 均为 v4，TSJ 找到对应攻击区和 WangSet，离线页无外部 URL；刷新后元数据仍从 SQLite 正文恢复，1440×900 与 390×844 均无页面级横向溢出。

本检查点不启动 ComfyUI/H3，不下载模型，不读取或改写正式项目、用户 `output`、D 盘正式桌面或快捷方式。

## 8. schema v5 调色板循环与动画事件扩展

`PIXEL-007/V0.7.43` 把调色板循环和动画事件纳入唯一权威 `PixelDocument`，而不是把它们保存成工作台临时状态或导出器私有参数。调色板循环适合火焰、水面、霓虹和能量流等“像素索引不变、显示颜色随时间切换”的效果；动画事件用于在某一命名片段的某个基础帧触发标记、音效、命中或自定义载荷。

文档新增两个顶层数组：

```ts
type PixelPaletteCycle = {
  id: string
  name: string
  colorIds: string[]
  stepDurationMs: number
  direction: 'forward' | 'reverse' | 'ping-pong'
  enabled: boolean
}

type PixelAnimationEvent = {
  id: string
  name: string
  type: 'marker' | 'sfx' | 'hit' | 'custom'
  animationTagId: string
  frameId: string
  value: string
}
```

当前限制为最多 16 个循环、每循环 2—32 个现有颜色、20—60000ms 整数步长和最多 256 个事件。同一颜色最多属于一个循环；事件必须同时引用现有片段和该片段闭区间内的现有帧，`value` 最长 160 字符。事件内容只作数据交付，工作台、查看器和导出器不会执行脚本，也不内嵌音频文件。

`paletteCycles[].colorIds` 的顺序就是显示映射顺序。正向循环按步数向前映射，反向使用相反偏移；往返采用 `0 → … → length-1 → … → 1`，不额外重复折返点。禁用循环回到恒等映射。v4 迁移时补空循环和事件，v3/v2/v1/v0 继续经既有显式链进入 v5；缺失版本、未知版本或伪装旧版本却携带新字段的输入失败关闭。

## 9. 引用完整性与可逆命令

循环的创建、删除、恢复和局部修改分别使用 `palette-cycles.add/remove/restore/patch`；事件使用 `animation-events.add/remove/restore/patch`。全部公开命令先构造完整候选并通过 `assertPixelDocument()`，成功后只增加一个 revision，并返回可直接应用的完整逆命令。

引用约束包括：

1. 循环只能引用当前调色板中的唯一颜色 ID，跨循环复用颜色被拒绝；
2. 仍被事件引用的帧不能删除，即使它不是片段边界；
3. 仍有事件的片段不能删除；
4. 调整片段范围或重排帧时重新验证全部事件，任何事件被排除在新闭区间外则整笔命令失败；
5. 删除循环引用颜色前必须先修改或删除相应循环。

## 10. 预览与确定性合成

`resolvePixelPaletteCycleMap(document, elapsedMs)` 只返回颜色 ID 到颜色 ID 的确定性映射。`renderPixelFrameRgba()` 在混合图层前对 Cel 颜色索引应用该映射，再读取目标 RGBA；图层组、显隐、透明度和 `normal/multiply/screen/add` 仍由同一核心合成器处理。

工作台只在播放且至少一个循环启用时以约 32ms 频率更新瞬态 `paletteCycleElapsedMs`。停止、编辑、撤销、重做或打开项目会把时间归零。时间不进入 PixelDocument，因此播放前后序列化字节、活动帧、revision 和撤销栈不变。Sprite 与游戏 Atlas 默认导出零时刻颜色；循环定义进入 metadata，由消费端在运行时复现。

## 11. 活动片段两文件交付

`createPixelAnimationClipExportBundle()` 为活动片段输出：

1. `*-clip.png`：片段范围内每个唯一基础帧只保存一次；
2. `*-clip.json`：保存源文档/revision、Atlas 布局、片段定义、精确播放序列与逐项时长、片段事件、逐帧游戏元数据、图层组、混合模式、调色板与循环。

八帧往返片段的 Atlas 只有 8 个单元格，播放序列仍为 14 项：`1,2,3,4,5,6,7,8,7,6,5,4,3,2`。因此回程不会重复复制 PNG 像素，也不会丢失实际播放语义。既有六文件游戏资产包仍输出项目、Sprite、manifest、Tiled TSJ/TMJ 和离线查看器；PixelDocument、Sprite metadata 与 manifest 均升级为 schema v5，并携带循环和事件事实。

## 12. V0.7.43 验证口径

- 像素核心、转换与游戏交付专项 28/28；
- 全仓单元契约 281/281；
- TypeScript、生产构建和 96 项默认安全基线通过；
- P7 六阶段集成通过。

P7 在 D 盘隔离项目和后台系统 Edge 中建立“灵光轮转”乒乓循环（80ms）、“八方演武”往返片段和绑定帧的“剑鸣”音效事件（`sfx.sword`），播放预览后实际下载两文件活动片段包及既有六文件游戏包。脚本逐项验证项目、manifest 和 clip 为 schema v5，Atlas 8 个唯一帧、播放序列 14 项且事件/循环同源；刷新后控件从 SQLite 正文恢复，1440×900 与 390×844 无页面级横向溢出，页面无 warning/error。

本扩展不实现脚本事件执行、音频资源内嵌、循环曲线、GPU Shader 导出、烘焙 GIF/APNG、Worker 化或 Godot/Unity/RPG Maker 原生导入器。本检查点没有启动 ComfyUI/H3，没有读取或改写正式项目、既有 output、D 盘正式桌面或快捷方式，也没有重新封装安装包。

## 13. V0.7.44 Terrain 九宫格输入与角门

`createPixelTerrainPreviewLayout()` 接受严格的目标 `terrainId` 和固定九项布尔占用数组。数组按行优先表示 3×3 网格；网格外始终视为空，空格不匹配图块。每个占用格继续复用 N/NE/E/SE/S/SW/W/NW 的 `1/2/4/8/16/32/64/128` 位序计算期望 Mask，但四个斜角必须同时满足斜向格和相邻两条正交边均被占用：例如东北位只有北、东、东北三格同时存在时才能置位。该角门避免凹角被错误填成实心圆角。

工作台提供岛屿、走廊、转角和实心四个不可变预设，也允许逐格切换。九宫格布局、匹配结果和 RGBA 都由当前 PixelDocument 与瞬态占用图派生；改变预设、单格或预览不会写正文、revision 或撤销栈。只有“应用本格 Mask”会把中心格推导出的期望规则通过现有 `frames.patch` 写回活动帧，因此整次应用只形成一个可逆修订。

## 14. 精确匹配与可解释降级

候选只来自同一 `terrainId` 的现有帧，且必须已有 `tileRule`。每个占用格依次执行：

1. 优先选择 bitmask 与期望值完全相同的帧；
2. 没有精确帧时，比较期望 Mask 与候选 Mask 的 XOR 置位数，即 Hamming 距离；
3. 距离相同则按 PixelDocument 的帧顺序，再按稳定帧 ID 排定；
4. 布局逐格保存期望 Mask、命中 Mask、来源帧、距离和 `exact`，不得把降级帧冒充精确结果。

未知 Terrain、没有任何候选帧、非九项占用、非布尔值或未知选项均失败关闭。素材不完整不会随机抛弃预览，而是给出稳定、可复现且可追踪的降级数量，便于作者按缺失 Mask 补画图块。

## 15. 两文件预览交付

`renderPixelTerrainPreviewRgba()` 复用核心 `renderPixelFrameRgba()` 合成每个来源帧，把九格按最近邻像素精确复制到透明 3×3 Atlas；相同来源帧只渲染一次并复用缓存。`createPixelTerrainPreviewExportBundle()` 输出：

1. `*-<terrain>-terrain-preview.png`：尺寸固定为 `document.width × 3` 乘 `document.height × 3`；
2. `*-<terrain>-terrain-preview.json`：`aeonquill.pixel-terrain-preview` schema v1，保存源文档 ID/revision、Terrain、网格与单格尺寸、原始占用、精确/降级计数，以及每格的期望/命中 Mask、来源帧和精确性。

预览包是当前 Terrain 素材完整性的设计/审阅产物，不改变既有六文件游戏包，也不宣称是 Godot、Unity 或 RPG Maker 的原生导入格式。

## 16. V0.7.44 验证口径与边界

- 像素核心、转换与游戏交付专项 30/30；
- 全仓单元契约 283/283；
- TypeScript、生产构建和 96 项默认安全基线通过；
- P7 六阶段集成通过。

固定向量覆盖全满九宫格、斜角门控、精确命中、缺帧 Hamming 降级、同距稳定排序、RGBA 拼接、PNG/JSON 事实一致和非法输入失败关闭。P7 在 D 盘隔离项目和后台系统 Edge 中选择“转角”，得到 1 格精确、3 格降级，随后把活动帧中心规则从 Mask 5 原子更新为 Mask 7，实际下载并解析九宫格 PNG/JSON；刷新后 Mask 7 从 SQLite 正文恢复，1440×900 与 390×844 无页面级横向溢出，页面无 warning/error。

本检查点不实现任意尺寸 Tilemap 绘制、地形笔刷、图块自动生成、嵌套/多 Terrain 混合、Worker 化或三引擎原生导入器；也没有启动 ComfyUI/H3、读取或改写正式项目、既有 output、D 盘正式桌面或快捷方式，或重新封装安装包。

## 17. V0.7.45 三引擎桥接包

`createPixelEngineBridgeExportBundle()` 不改变 PixelDocument schema，也不改写既有六文件游戏包、活动片段包或九宫格包。它复用同一次 `createPixelExportBundle()` 和 `createPixelGameManifest()` 结果，独立输出六项：

1. `*-sprite-sheet.png`：与游戏交付同布局、同 RGBA 合成器的共享 Atlas；
2. `*-engine-bridge.json`：`aeonquill.pixel-engine-bridge` schema v1；
3. `*-godot-import.gd`：Godot 4 EditorScript；
4. `AeonQuillPixelImporter_<稳定八位哈希>.cs`：Unity 2021.2+ Editor 脚本；
5. `$*-character.png`：RPG Maker MZ 单角色 3×4 图；
6. `*-engine-README.md`：安装步骤、来源和明确边界。

桥接 manifest 保留源文档 ID、revision、schema、坐标系、帧 Atlas、逐帧锚点/碰撞/Terrain、所有动画及精确播放帧、动画事件、八方向映射、Tilemap、图层组/混合、调色板和循环。三个目标格式只读取这份事实；脚本不执行事件、不内嵌音频，也不把矩形碰撞或 Terrain 自动伪造成引擎节点。

## 18. Godot 与 Unity 导入语义

Godot 脚本在项目编辑器中运行，读取同目录桥接清单和 PNG，为每个动画创建 `SpriteFrames` 与 `AtlasTexture` 区域。动画速度固定为 `1000.0 FPS`，每帧相对时长直接使用 `durationMs`，因此绝对秒数为 `durationMs / 1000`；循环标记映射为 `LOOP_LINEAR` 或 `LOOP_NONE`，最后由 `ResourceSaver.save()` 写入同目录 `.tres`。该策略依据 [Godot SpriteFrames](https://docs.godotengine.org/en/stable/classes/class_spriteframes.html) 与 [ResourceSaver](https://docs.godotengine.org/en/stable/classes/class_resourcesaver.html) 的公开契约。

Unity 脚本面向 2021.2+，要求 2D Sprite 包，用户选择桥接 JSON 后从同目录定位 Atlas。TextureImporter 固定为 Sprite/Multiple、Point、无 Mipmap、Uncompressed、Alpha transparency 与 Clamp；切片通过官方 [Sprite Editor Data Provider API](https://docs.unity3d.com/current/Manual/sprite/sprite-editor/sprite-editor-data-provider-api.html) 完成。AEONQUILL Atlas 使用左上原点，Unity Rect 使用纹理左下原点，因此纵坐标严格换算为 `texture.height - top - height`；锚点转为 `pivotX = x / width`、`pivotY = 1 - y / height`。重复导入先按 `frame.name + "__" + frame.id` 查找既有 Sprite ID，命中时复用，避免引用无故漂移；新项才生成 GUID，并同步名称/FileID 对。

两份脚本都把导出后可能被手工改写的 JSON 当作不可信输入：Atlas 只允许清单同目录的 `.png` 文件名，拒绝绝对路径、目录分隔符和路径穿越；帧 ID、数组结构、图集矩形、纹理边界和时长均在生成引擎资源前复核。Unity 还会先验证有限数值、PPU、锚点和稳定名称唯一性，再改变 TextureImporter 设置；错误清单因此失败关闭，不留下可继续执行的越界切片或半导入状态。

## 19. RPG Maker MZ 3×4 角色图

RPG Maker MZ 单角色资源按官方 [Asset Standards](https://rpgmakerofficial.com/product/MZ_help-en/01_11_01.html) 使用 `$` 文件名前缀、3 列 pattern 与 4 行方向。行序固定为：

| 行 | AEONQUILL 方向 | RPG Maker 方向 |
| ---: | --- | --- |
| 0 | `south` | 下 |
| 1 | `west` | 左 |
| 2 | `east` | 右 |
| 3 | `north` | 上 |

每个方向只接受一个或三个现有 frame ID。三个 ID 按列直接拼接；只有一个时三列重复同一帧，并在 `rpgMakerMz.cells[].repeated` 标为 `true`，不虚构不存在的步态。RGBA 逐行复制、关闭插值且保留透明像素；输出尺寸始终为 `document.width × 3` 和 `document.height × 4`。默认映射从现有八方向的四个正交方向选择一个来源帧，因此默认包的 12 格都会诚实标记为重复，用户后续可由 API 传入真实三 pattern 映射。

## 20. V0.7.45 验证口径与边界

- 像素核心、转换与游戏交付专项 32/32；
- 全仓单元契约 285/285；
- TypeScript、生产构建和 96 项默认安全基线通过；
- P7 六阶段集成通过。

固定契约验证桥接文件引用、源 revision、RPG Maker 行序/尺寸/透明 RGBA/重复来源、Godot 1000 FPS 毫秒时长与 ResourceSaver、Unity 坐标/pivot/Point/无 Mipmap/无压缩和稳定 ID 策略，以及两份导入脚本的同目录 PNG、矩形边界和空字段防护；两 pattern、未知帧、非法 PPU 和未知选项全部失败关闭。P7 在 D 盘隔离项目与后台系统 Edge 中继既有十项交付后点击“引擎桥接包”，实际产生六个新增下载；脚本解析桥接 JSON、两份导入脚本、RPG PNG 与 README，确认 schema v5 来源、8 帧、动画/事件/循环、12 格行序和公开参考一致。合计 16 次下载，刷新后正文保持恢复，1440×900 与 390×844 无页面级横向溢出，页面无 warning/error。

当前机器未发现 Godot、Unity Editor 或 RPG Maker MZ 可执行文件，因此本检查点只证明生成器、脚本契约和真实浏览器交付通过，**不宣称原生编辑器导入、运行或双向往返已经实机完成**。桥接包不会自动写入任何引擎项目，也没有启动 ComfyUI/H3、读取或改写正式项目/既有 output、重封安装包或替换 D 盘正式桌面。

## 21. V0.7.46 严格内存选区剪贴板

`createPixelSelectionClipboard()` 从一个已验证 Cel、画布尺寸和矩形选区建立 `aeonquill.pixel-selection-clipboard` schema v1。快照只存在于当前像素工作台内存，记录源文档 ID/revision、frame ID、layer ID、源画布宽高、选区尺寸及以选区左上角为原点的相对像素；最大面积固定为 65,536。捕获前拒绝未知字段、非法 ID/修订、选区越界、Cel 长度不符和非法像素值，不把损坏状态带入后续目标。

`createPixelSelectionPastePatch()` 每次粘贴重新验证剪贴板完整性、目标 Cel、目标画布、落点和目标调色板。`replace` 对选区内每个坐标执行完整覆盖，包括把透明值 `null` 写入目标；`opaque-only` 跳过透明来源，只覆盖有颜色的像素。像素采用固定长度稠密行优先数组，自由坐标和重复相对坐标在 schema 层不可表达；未知颜色、长度不符、非法来源元数据、未知模式和超出目标边界全部失败关闭。结果只返回有实际差异的最小像素补丁，因此无变化不会生成伪 revision。

剪贴板不写入 PixelDocument、SQLite 项目正文、导出包或系统剪贴板，也不改变 schema v5。这样既避免二进制/敏感临时内容跨项目隐式传播，也保持现有 v0—v4 迁移和游戏交付完全兼容。安装、导入或重开任一完整文档都会清空瞬态剪贴板；已粘贴并提交的像素仍像普通编辑一样持久化。

## 22. 工作台、命令与历史语义

工作台选区栏新增复制、剪切、粘贴及透明语义切换，同时提供 `Ctrl+C`、`Ctrl+X`、`Ctrl+V`。复制只捕获当前活动 frame/layer 的选区，不修改正文和 revision；剪切先捕获同一快照，再用至多一次既有 `pixels.patch` 清空来源中的实际非透明像素；粘贴以当前选区左上角为目标，若当前没有选区则使用来源选区的原位坐标。目标层隐藏或锁定时仍由命令总线拒绝执行，UI 不绕过核心权限。

一次剪切或粘贴最多产生一次 revision 和一条撤销记录，撤销/重做复用既有完整逆命令。粘贴无差异时保持 revision 不变；复制后可以切换到不同 frame 和不同 layer，再在目标上提交。状态徽标只显示剪贴板尺寸、来源帧/层和当前透明模式，不保存完整像素到 DOM 属性或日志。

## 23. V0.7.46 验证口径与边界

- 像素核心、转换、工具与游戏交付专项 38/38；
- 全仓单元契约 287/287；
- TypeScript、生产构建和 96 项默认安全基线通过；
- P7 六阶段集成通过。

固定向量覆盖跨 Cel 复制、`replace`/`opaque-only`、源矩形与稠密相对像素、损坏 schema、未知字段、非法来源身份、长度不符、未知颜色和源/目标越界。P7 在 D 盘隔离项目与后台系统 Edge 中读取真实框选 DOM 几何，框选 2×2 来源区域，在一个 frame 的 light 图层执行剪切、撤销、重做并再次撤销恢复，再粘贴到另一个 frame 的 silhouette 图层；先锁定目标确认 `Layer silhouette is locked`，再解锁粘贴并完成单步撤销/重做。导出的 PixelDocument 精确比较目标选区和已恢复来源像素，刷新后粘贴结果保留，1440×900 与 390×844 继续通过且页面无 warning/error。

本检查点不提供操作系统剪贴板、跨浏览器标签或跨项目剪贴板持久化，也不提供旋转、缩放、羽化或自由变换选区；刷新后剪贴板按设计清空。它没有启动 ComfyUI/H3、改写正式项目/既有 output、重封安装包或替换 D 盘正式桌面。

## 24. V0.7.47 持久化任意尺寸 Terrain Map

`PixelDocument schema v6` 在既有逐帧 Terrain ID/Mask 之外新增严格 `terrainMaps` 正文。单文档最多 16 张地图；每张地图保存稳定 ID、名称、Terrain ID、1—64 的宽高和长度恰好等于 `width × height` 的稠密布尔占用数组，总格数不得超过 4096。schema v5 只通过显式迁移补空地图数组，v0—v4 继续沿既有迁移链进入 v6；未知字段、重复 ID、空名称/Terrain ID、尺寸/长度不符、非布尔格和超限值全部失败关闭。

`terrain-maps.add/remove/restore/patch/resize/restore-shape/cells.patch` 覆盖完整生命周期。删除、内部恢复、属性修改、尺寸变更和格补丁都生成精确逆命令；恢复类命令只允许内部 actor。改尺寸以左上角为锚保留交叠区，新区域为空；相同尺寸、重复坐标、无实际变化和未知地图均被拒绝，避免伪 revision。工作台最多打开一个活动地图，支持创建/切换/改名/改 Terrain、宽高调整、绘制/擦除、填满/清空和撤销/重做。拖动期间以线段栅格化填补事件间隔并只更新本地草稿，指针释放后将实际差异合并成一条去重 `terrain-maps.cells.patch`。

## 25. 任意尺寸推断、交付与验证边界

`createPixelTerrainMapLayout()` 把任意合法宽高的占用图按行优先处理；每个占用格继续用 N/NE/E/SE/S/SW/W/NW 位序和相同斜角门推导期望 Mask。候选只取同 Terrain，按精确命中、Mask Hamming 距离、PixelDocument 帧顺序和稳定帧 ID 选取，因而同一正文总能得到相同来源；没有候选时返回 `UNKNOWN_TERRAIN`，已保存地图仍可编辑但不能伪造渲染结果。

`createPixelTerrainMapExportBundle()` 交付四项同源文件：

1. `*-terrain-map.png`：按地图宽高和原始像素单元拼接的最终地图；
2. `*-terrain-map-source-sprite-sheet.png`：只包含本次布局实际使用来源帧的 Sprite Atlas；
3. `*-terrain-map.json`：`aeonquill.pixel-terrain-map` 严格事实，保存源文档/revision、地图、占用、候选图集和逐格期望/命中 Mask、来源、距离、精确性与 GID；
4. `*-terrain-map.tmj`：可直接被 Tiled 打开的有限正交地图，Tileset 内联到 TMJ，避免把未交付的外部 TSJ 当成依赖。

核心、转换与游戏专项合计 34/34；全仓 289/289、TypeScript、生产构建和 96 项默认安全基线通过。P7 在 D 盘隔离项目与后台系统 Edge 中创建 6×4 地图，以连续指针轨迹绘制 9 格 L 形区域，验证单步撤销/重做、四文件实际下载/解析、SQLite 刷新恢复和 1440×900/390×844 无页面级横向溢出；页面无 warning/error。该检查点没有启动 ComfyUI/H3、读取或改写正式项目/既有 output、重封安装包或替换 D 盘正式桌面，也不宣称多 Terrain 同图混合、自动生成缺失图块、Worker 化或三引擎原生地图导入已完成。

## 26. V0.7.48 多 Terrain 地图正文与编排

`PixelDocument schema v7` 把每张 Terrain Map 从“地图级 `terrainId` 加布尔 `occupancy`”升级为固定长度 `cells: Array<string | null>`。每个非空格直接保存稳定 Terrain ID，因此一张地图可以同时包含多种地形，空格仍以 `null` 明确表达；地图数量、1—64 单边和最多 4096 格预算保持不变。v6 迁移先严格验证旧地图字段、尺寸、唯一 ID 和布尔长度，再把每个真值映射为旧 `terrainId`、假值映射为 `null`，因而不会丢失任何占用或把损坏文档静默补空。v5 及更早版本继续沿原显式迁移链进入 v7。

`terrain-maps.cells.patch` 的单格事实变为 `{x, y, terrainId}`，其中 `terrainId` 可为稳定 ID 或 `null`。重复坐标、未知字段、越界、非法 ID 和无实际变化仍失败关闭；逆命令逐格保存原 Terrain ID。尺寸变更以 `null` 初始化新区域、保留左上交叠区，并通过 `restore-shape` 保存完整旧 `cells`，因此混合地图也可一次撤销。地图属性补丁只允许名称，避免再次产生与逐格正文冲突的地图级 Terrain。

工作台从当前全部帧的 `tileRule.terrainId` 建立画笔下拉选项；画笔将选中 ID 写入格子，橡皮写入 `null`，“当前 Terrain 填满”只使用所选 ID。连续轨迹仍由栅格线补点、拖动期间只维护瞬态 ID 草稿，抬笔后按实际差异提交一个原子命令。预览不可渲染时用 Terrain ID 的稳定哈希颜色区分各类，而不会把所有地形伪装成同一颜色；没有帧规则时禁用画笔但保留既有地图事实供修复。

`createPixelTerrainMapLayout()` 输出 `aeonquill.pixel-terrain-map` schema v2。对每个非空格，八邻域只有与当前格 Terrain ID 完全相同的邻格才可置位；异种 Terrain、空格和越界均视为空，斜角仍要求同 Terrain 的斜格与两条正交门同时存在。候选按该 Terrain 独立过滤，再依次按精确 Mask、Hamming 距离、文档帧顺序和稳定 ID 选择。布局公开稳定首现顺序的 `terrainIds`、逐格 `terrainGrid`、每格 Terrain、期望/命中 Mask、来源、距离及精确性；空地图可透明渲染，任一已用 Terrain 没有候选则整体返回 `UNKNOWN_TERRAIN`，不以其他 Terrain 偷换图块。

## 27. V0.7.48 交付、迁移与验证边界

四文件包保持原文件数量，但内容升级为多 Terrain 事实：地图 PNG 由逐格匹配来源合成；来源 Sprite 是与项目导出共享的完整 Atlas；JSON 保存 schema v2 布局及逐格 Terrain；TMJ 内联同一 Atlas 的 Tileset，并为全部有帧规则的 Terrain 生成独立 WangSet。TMJ 顶层同时写入 `aeonquillTerrainIds` 和 `aeonquillTerrainGrid` JSON 字符串属性，tile layer 的 GID 仍只引用同一 manifest 的帧序，不建立第二套来源事实。

验证结果：

- 核心、转换和游戏交付定向测试 34/34；全仓单元契约 289/289；
- TypeScript、生产构建、确定性图像处理、隔离 API、自定义工作流、空间生命周期和双尺寸浏览器组成的 96 项默认基线通过；
- 固定测试覆盖 v6→v7 无损迁移、逐格多 ID 命令及精确逆操作、保留左上尺寸变更、同类角门、异种边界隔离、稳定降级、多 WangSet/TMJ 逐格事实、未知 Terrain 和非法选项失败关闭；
- P7 在后台系统 Edge 中为两个真实帧登记 `wuxia-floor` 与 `mist-water`，于 6×4 地图绘制相邻转角共 16 格，验证第二笔一次撤销回到 9 格、重做到 16 格，实际解析 20 个交付文件中的地图 PNG、共享 Atlas、schema v2 JSON 和双 WangSet TMJ；SQLite 刷新恢复、1440×900、390×844、无横向溢出及无页面 warning/error 全部通过。

本检查点不自动生成缺失 Mask 图块，不引入地形层/对象层叠加、Worker 化、三引擎原生地图导入或双向回写；也没有启动 ComfyUI/H3、读取或改写正式项目/既有 output、重封安装包或替换 D 盘正式桌面。产品 SemVer 仍为 0.7.1，正式桌面仍是 V0.7.30 功能轨。
