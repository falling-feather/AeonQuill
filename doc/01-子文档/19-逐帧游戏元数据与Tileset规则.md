# 光阴砚 AEONQUILL — 逐帧游戏元数据与 Tileset 规则

> 该文档隶属于[01-开发者文档第 6 节](../01-开发者文档.md#6-模块实现)，用于补充像素逐帧锚点、碰撞区、地形位掩码及游戏交付的可复核事实。
>
> **文档梗概**：说明 `PIXEL-006 / V0.7.42` 建立的 PixelDocument schema v4、逐帧游戏元数据编辑、画布辅助线、Tiled 碰撞对象/WangSet 和六文件同源交付。
>
> **最后一次更新时间**：2026-09-03
>
> **更新者**：主开发、像素模式责任域、前端与游戏资产责任域
>
> **对应检查点**：`PIXEL-006 / V0.7.42`

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

本检查点不提供任意多边形/圆形碰撞、嵌套碰撞层、基于像素轮廓的自动碰撞生成、Dual-grid 推导、动画事件、Godot/Unity/RPG Maker 原生导入器或双向编辑。上述能力继续作为后续独立任务。

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
