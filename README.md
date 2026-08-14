# 光阴砚 AEONQUILL

> **以光为墨，以时为卷。**<br>
> **一念落砚，万象成章。**<br>
> **Shape Light. Weave Time.**

一个把无限画布、浏览器图像处理、像素画编辑、本地图像模型与 ComfyUI 视频生成组合在一起的本地优先多模态创作软件原型。产品将以“均衡模式”“像素模式”“智能视频”三个入口组织能力：均衡模式承载 Lovart 风格的画布与图像/视频组件，像素模式承载 Meowa/Aseprite 风格的像素资产生产，智能视频承载从灵感或剧本到镜头、素材和成片的受控工作流。

当前已接通 MiniMax H3 Turbo 文生/图生视频，以及 FFmpeg 确定性处理、rembg 去背景和 Real-ESRGAN 超分；图片与视频统一进入持久化 CPU/GPU 调度器，具备幂等、优先级、超时、取消、恢复、资源用量事件和不可变输出版本。画布使用版本化 `CanvasDocument`、空间索引和视口裁剪，正式项目通过 SQLite WAL、SHA-256 内容寻址资产、分级图片预览和可校验的 `.miaohui` 项目包持久化。

`.miaohui`、`MIAOHUI_*` 等名称暂时作为旧项目与运行时的兼容标识保留，不代表当前对外品牌；它们将在具备迁移和回滚方案后再统一更新。

桌面封装已完成 Electron/Tauri 同核实验：当前暂定 Tauri + 自包含 Node 22 sidecar 作为 Windows 个人分发候选，Electron 保留为回退壳。真实 NSIS 安装—启动—卸载闭环已经通过，但产物仍未签名，也没有自动更新或回滚，不能视作正式商业发行版。

本地桥接只监听回环地址。生产页面会取得进程内随机 HttpOnly 会话，后续 API 同时校验 Host、Origin/Fetch Metadata 与会话；资产路径、公开日志、子进程环境和 ComfyUI 节点映射均经过白名单或脱敏处理。

## 快速启动

需要 Node.js 22、npm，以及已经部署 H3 模型与节点的 ComfyUI。

```powershell
npm install
Copy-Item config/local.example.json config/local.json
```

编辑被 Git 忽略的 `config/local.json`，填写本机 `comfyRoot` 与 `pythonPath`。随后运行：

```powershell
npm run app
```

该命令会先构建前端，然后在 `http://127.0.0.1:8787` 启动常驻页面和本地 API。默认采用按需模式：ComfyUI 在提交视频任务或手动点击“启动”时冷启动，队列持续空闲 5 分钟后自动关闭 AEONQUILL 创建的进程；外部 ComfyUI 只会被复用。使用 `Ctrl+C` 关闭统一启动器。

开发模式使用两个终端：

```powershell
# 终端 1：ComfyUI 已启动时运行桥接服务
npm run server

# 终端 2：Vite，/api 自动代理到 8787
npm run dev
```

## 当前能力

- 无限画布平移、缩放、框选、多选、拖动、八向缩放、锁定、显隐、复制、删除与缩略导航。
- 空间索引、视口外裁剪、动画帧相机提交和 Canvas 小地图；图片按 512px 缩略图、1600px 预览图、原图三级加载。
- 文字、便签、形状、画框、图片、像素画、连接线与视频元件。
- 图片拖拽导入、色彩调整、裁剪、浅色背景移除草稿、像素化和浏览器插值放大。
- 可变尺寸像素编辑、K-means 调色板量化、Bayer 抖动与最近邻像素结果。
- MiniMax H3 Turbo 文生视频与图生视频，5/10/15 秒、16:9/9:16/1:1、原生音频和结构化导演控制。
- 图生视频首帧与可选末帧在浏览器端确定性地 cover 裁切到目标尺寸，避免 H3 节点直接拉伸源图。
- 面向 8GB 显存的稳定预览、细节与 720P 交付档，以及建议 12GB 的原生高清实验档；界面分别标注生成尺寸、交付尺寸、最低显存和风险。
- ComfyUI 常驻、按需空闲关闭、完全手动三种策略；支持冷启动状态、空闲倒计时、安全启停和休眠时硬件提示。
- ComfyUI/GPU 就绪状态、队列、真实采样步数、解码/封装/保存阶段、日志、取消、快速重试与可操作错误提示。
- 图片/视频统一资源调度：CPU/GPU 独立容量、优先级、幂等键、尝试上限、安全超时、低磁盘前检、重启恢复和本机算力用量。
- MP4 本地资产持久化、Range 分片播放和生成结果自动回填画布。
- 本地自动保存、撤销重做、SQLite 项目恢复、不可变资产版本、完整 `.miaohui` 项目包导入/导出与桌面/移动端响应式界面。
- Electron/Tauri 共享回环桥接与沙箱页面；Tauri Node 22 sidecar、NSIS 安装卸载和两壳启动/内存/包体对照基准。

## 验证

```powershell
# 日常快速反馈：语法、46 项单元/离线/画布/项目存储/调度/桌面契约/预览缓存与安全契约、TypeScript
npm run validate:quick

# 默认发布前基线：再加入构建、真实 FFmpeg、隔离 API/SSE/Range、桌面与移动端浏览器
npm run validate

# 仅当 ComfyUI 已在线时：默认基线 + 实时 H3 节点/模型契约
npm run validate:live

# 固定 300 轻节点 + 30 个真实 4K 图片节点的桌面/窄屏性能门槛
npm run benchmark:canvas -- --label=desktop --viewport=desktop --assert
npm run benchmark:canvas -- --label=mobile --viewport=mobile --assert

# 已有 release 产物的桌面专项门禁：sidecar、两壳生命周期、NSIS 安装卸载和资源对照
npm run validate:desktop:release
```

默认基线不会启动 ComfyUI，并为本地 API 与浏览器测试创建独立临时运行时，避免改写正式 Job、项目数据库和资产。最近一次机器可读结果写入 `.runtime/qa/latest.json`。如需单独定位，可运行 `npm run validate:api`、`npm run validate:browser`、`npm run validate:image-tools` 或 `npm run validate:workflows`。

运行时文件保存在 `.runtime/`，包括任务记录、输入、执行期图片/视频资产、项目 SQLite、内容寻址项目资产、模型与本机工具、下载校验清单和 `comfyui.log`；它们不会进入 Git。当前项目存储使用 Node.js 22 内置 `node:sqlite`，桌面封装前必须固定并回归同一 Node 运行时，不应随意替换为未经迁移验证的版本。

浏览器去背景和放大仍可作为快速草稿；正式按钮现在会调用本机 `u2netp` 与 Real-ESRGAN。当前桥接仍是单机服务，并非多用户云服务；账号、支付、内容审核、安装包签名与自动更新尚未实现。模型/权重的商业分发许可仍需在发布前完成法律核对。

详细架构与故障排查见 [`doc/01-开发者文档.md`](doc/01-开发者文档.md)、[`doc/01-子文档/11-本地H3视频工作流.md`](doc/01-子文档/11-本地H3视频工作流.md)、[`doc/01-子文档/12-无限画布性能与资源分级.md`](doc/01-子文档/12-无限画布性能与资源分级.md)和[`doc/01-子文档/13-桌面封装与发行架构.md`](doc/01-子文档/13-桌面封装与发行架构.md)。最新图片工作台概念稿见 [`design/image-enhancement-center-v5.png`](design/image-enhancement-center-v5.png)，视频导演稿见 [`design/video-director-runtime-v4.png`](design/video-director-runtime-v4.png)。
