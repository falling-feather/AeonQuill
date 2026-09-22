# 光阴砚 AEONQUILL — 逐帧游戏元数据、Terrain 与引擎交付

> 该文档隶属于[01-开发者文档](../01-开发者文档.md)，用于说明游戏元数据、Terrain、Tileset 与引擎交付。
> 本文回答：锚点、碰撞区、8 邻域 Tileset、多 Terrain 地图、八方向角色和 Godot/Unity/RPG Maker 导出怎样实现。

**最后一次更新时间**：2026-09-23

**更新者**：像素模式组、游戏资产责任域、文档专项组

---

## 1. 功能入口

像素模式右侧“逐帧游戏数据”编辑：

- 当前帧锚点。
- 最多 8 个碰撞矩形。
- 可选 Terrain ID 与 8 邻域 bitmask。
- 3×3 Terrain 预览。
- 持久化多 Terrain Map。
- 游戏包与三类引擎桥导出。

实现：

| 职责 | 文件 |
| --- | --- |
| 正文校验与命令 | `src/lib/pixel/pixelCore.mjs` |
| Terrain 推断与游戏导出 | `src/lib/pixel/pixelGamePipeline.mjs` |
| 类型 | `src/lib/pixel/pixelGamePipeline.d.mts` |
| UI | `src/modes/pixel/PixelModeWorkbench.tsx` |
| 测试 | `tests/pixel-game-pipeline.test.mjs` |

---

## 2. 逐帧 Gameplay

每个 frame：

```ts
gameplay: {
  anchor: { x: number; y: number }
  collisions: CollisionRect[]
  tileRule: { terrainId: string; bitmask: number } | null
}
```

默认锚点为 `(floor(width/2), height)`，即角色脚底中央。

碰撞类型：

```text
solid / hitbox / hurtbox / interaction
```

每个矩形拥有 id、name、type、x、y、width、height；坐标以像素文档左上角为原点。每帧最多 8 个。

辅助线只显示在编辑器和离线检查器，不进入 Sprite 像素。

---

## 3. 8 邻域 bitmask

位定义固定为：

| 邻居 | bit |
| --- | ---: |
| 北 | 1 |
| 东北 | 2 |
| 东 | 4 |
| 东南 | 8 |
| 南 | 16 |
| 西南 | 32 |
| 西 | 64 |
| 西北 | 128 |

斜角有 corner gate：

```text
东北有效 = 东北同 Terrain AND 北同 Terrain AND 东同 Terrain
东南有效 = 东南同 Terrain AND 南同 Terrain AND 东同 Terrain
西南有效 = 西南同 Terrain AND 南同 Terrain AND 西同 Terrain
西北有效 = 西北同 Terrain AND 北同 Terrain AND 西同 Terrain
```

这避免只有对角连接时错误使用内角图块。

---

## 4. 3×3 Terrain 预览

预设：

| ID | 形状 |
| --- | --- |
| island | 仅中心 |
| corridor | 横向三格 |
| corner | 上、右和右上转角 |
| solid | 九格全满 |

占用图是瞬态 9 项布尔数组，不修改 revision。点击“应用中心规则”时，才把中心格推导出的 bitmask 通过一次 `frames.patch` 写入当前帧。

预览输出记录每格：

- 期望 bitmask。
- 匹配 frameId。
- exact / fallback。
- Hamming 距离。
- terrainId。

降级结果不得标记为精确。

---

## 5. 候选选择算法

同一 Terrain 的帧才是候选：

```text
计算目标 mask
→ 筛选 frame.gameplay.tileRule.terrainId 相同
→ 优先 bitmask 完全相等
→ 否则按 bit 差异数量（Hamming distance）升序
→ 再按文档帧顺序
→ 再按稳定 ID
```

若某 Terrain 在地图中被使用却没有任何帧规则，渲染和导出失败关闭，不使用其他 Terrain 的图块替代。

---

## 6. Terrain Map v7

```ts
type TerrainMap = {
  id: string
  name: string
  width: number
  height: number
  cells: Array<string | null>
}
```

约束：

| 项目 | 限制 |
| --- | --- |
| 地图数 | 16 |
| 宽/高 | 各 1—64 |
| 格子数 | 最多 4096 |
| cells 长度 | 必须等于 width×height |
| 单格 | 现有规则 Terrain ID 或 null |

UI 支持：

- 新建、删除、重命名。
- 宽高调整；保留左上重叠区域。
- 选择 Terrain 画笔。
- 绘制、擦除、当前 Terrain 填满。
- 实时显示 Terrain 种数、精确匹配和降级数。
- 导出 PNG/JSON/TMJ。

笔触期间只更新 draft cells；结束后用一次 `terrain-maps.cells.patch` 提交去重变化。

---

### 6.1 schema v8 的地形与对象层

地图新增 `terrainLayer.visible/locked` 和有稳定 ID 的 `objectLayers`。对象保存像素坐标、尺寸、名称、标量 properties，以及可选 `frameId/collisionId`。v7 项目迁移时得到可见未锁定 Terrain 层和空对象层；不会丢失原有多 Terrain 格。

所有编辑走 `pixelCore.mjs` 的 `terrain-object-layers.*` 与 `terrain-objects.*` 可逆命令，检查锁定、重复 ID、坐标界限和引用完整性。仍被对象使用的帧/碰撞区不能直接删除。对象锁定和显隐写入正文，撤销/重做、保存重开遵循相同语义。

TMJ 导出 objectgroup，JSON/manifest 保留同一对象事实；地图 PNG、共享 Atlas 与 TMJ 统一 columns/padding/spacing。`inspectPixelTerrainCoverage` 给出实际缺失邻接 mask 和受影响格，不静默补画。契约测试为 `tests/pixel-object-layers.test.mjs`；真实浏览器入口为 `scripts/validate-pixel-objects-worker-ui.mjs`。

## 7. 多 Terrain 推断

schema v7 的 map 不再拥有单一 terrainId。每格保存自己的 Terrain ID。

对于某一格：

- 只把相邻的相同 Terrain ID 视为连接。
- 不同 Terrain 视为空。
- 越界视为空。
- 每个 Terrain 使用自己的帧候选集合。
- 输出可以引用共享 Atlas 中来自多个 Terrain 的 frame。

schema v6 的 `{terrainId, occupancy[]}` 迁移为：

```text
occupancy true  → 原 terrainId
occupancy false → null
```

格子数量和左上重叠区语义必须保持。

---

## 8. 游戏 Manifest

`createPixelGameManifest()` 从当前严格文档派生：

- 文档尺寸和 schema。
- 共享 Sprite Atlas 布局。
- 每帧 duration。
- 锚点和碰撞矩形。
- tileRule。
- 八方向 frame 映射。
- 全部动画片段与精确播放序列。
- 动画事件。
- 图层/组、调色板和调色板循环。
- Terrain Maps。

manifest 是派生交付，不是第二套编辑事实。修改应回到 PixelDocument，再重新导出。

---

## 9. 八方向角色

固定方向顺序：

```text
south
south-west
west
north-west
north
north-east
east
south-east
```

用户可为每个方向选择 frame。未显式指定时按文档帧循环分配，便于最小预览，但生产交付应人工确认映射。

“确保八方向”辅助不会凭空生成新视角；帧不足时只能复用现有帧。真实多角度补画需要另接生成工作流并由用户审核。

---

## 10. Terrain 导出

| 包 | 内容 |
| --- | --- |
| 3×3 preview | 预览 PNG + 逐格 JSON |
| Terrain Map | 地图 PNG + schema v2 JSON + TMJ |
| 游戏包 | Sprite Atlas + manifest + 离线检查器 |
| 动画片段 | 片段 Atlas + sequence/events/cycles |

TMJ：

- 使用共享来源 Atlas。
- 为每个 Terrain 生成内联 WangSet。
- 保存每格 Terrain ID 和匹配帧。
- 碰撞区写入 objectgroup。
- 锚点、Terrain ID 和 bitmask 写入 properties。

---

## 11. Godot 4.x 桥

导出内容包括 Atlas PNG、桥接 manifest、GDScript 导入器和目标 `.tres` 名称。

导入器：

- 使用 AtlasTexture/SpriteFrames。
- 以 1000 FPS 为时间基准，将毫秒表示为相对帧时长。
- 从共享 manifest 读取动画序列。
- 不执行动画事件。
- 不自动创建碰撞节点或 Terrain 节点。

用户将目录复制到 Godot 项目，等待 PNG 导入后运行导入脚本。

---

## 12. Unity 2021.2+ 桥

要求 Unity 2D Sprite 包与 Sprite Editor Data Provider。

导入设置：

- Texture type Sprite / Multiple。
- Filter Point。
- Mipmap off。
- Compression uncompressed。
- 按共享 Atlas 切片。
- 左上原点锚点转换为 Unity 左下原点 pivot。
- 重复导入时按同名 Sprite 复用既有 ID。

碰撞、事件、Terrain 和调色板循环保留在 JSON，不自动创建运行时组件。

---

## 13. RPG Maker MZ 桥

单角色角色图规则：

- 文件名使用 `$` 前缀。
- 3 列 × 4 行。
- 行顺序：下、左、右、上。
- 每个方向接受 1 或 3 个 frameId。
- 只有 1 帧时显式复制到该方向三列。

RPG Maker 只支持四方向角色表；八方向中的斜向映射仍保留在通用 manifest，不伪装进 4 行图。

---

## 14. 修改 Terrain 规则

1. 修改 `PIXEL_TILE_NEIGHBORS` 或 gate 算法前先定义兼容策略。
2. 若 bit 含义变化，必须提升 PixelDocument schema，不能直接重解释旧 bitmask。
3. 更新 3×3 预览、持久地图、game manifest、TMJ 和离线检查器。
4. 增加所有 256 个 bitmask、角门、边界和多 Terrain 测试。
5. 确保 exact/fallback 统计和 Hamming 排序稳定。
6. 验证重复导出字节和帧选择确定性。

---

## 15. 修改引擎桥

1. 只消费 game manifest，不另建帧事实。
2. 固定目标引擎最低版本。
3. 记录坐标系、pivot、时间单位、Atlas ID 稳定规则。
4. 生成脚本必须可重复导入。
5. 不执行用户事件、不创建含游戏语义的节点，除非新增独立、明确审批的模块。
6. 用最小项目在真实引擎验证，再更新支持状态。

---

## 16. 验证

```powershell
node --test tests/pixel-core.test.mjs
node --test tests/pixel-game-pipeline.test.mjs
node --test tests/pixel-conversion.test.mjs
npm run build
```

测试矩阵：

- 256 个邻域 mask 与四个 corner gate。
- exact/fallback/Hamming/稳定顺序。
- 两种 Terrain 相邻不连接。
- 1×1、64×64 与 4096 格边界。
- resize 保留左上重叠区。
- v6 → v7 迁移不丢格。
- PNG/JSON/TMJ 使用同一布局。
- 锚点与碰撞区的坐标和数量限制。
- forward/reverse/ping-pong 动画交付。
- Godot/Unity/RPG 文件名、脚本和 manifest 引用完整。

---

## 17. 当前限制

- 对象层支持矩形位置/尺寸、标量属性及帧/碰撞引用；不提供任意脚本、旋转、多边形或嵌套对象。
- 缺失 bitmask 可查看准确缺口与补画建议；预览保留确定性 fallback，不自动生成或覆盖图块。
- 引擎桥是单向交付，不支持从引擎反向同步。
- 碰撞矩形不支持多边形、旋转或骨骼。
- 引擎脚本不执行事件、不嵌入音频，也不保证第三方插件兼容。
