# AEONQUILL V0.4 阶段测试包限制

- 安装包没有 Windows 代码签名，SmartScreen 信誉、企业部署和商店上架尚未完成。
- 不包含自动更新、差分更新、在线回滚或发布灰度渠道。
- 主 NSIS 不直接塞入超过 50 GiB 的 ComfyUI/Python/模型树；完整离线交付采用“应用安装器 + 可校验运行时目录 + 一键安装脚本”的拆分包。移动、删改目录或校验失败会阻止安装/执行。
- 完整离线目录固定包含 ComfyUI、便携 Python、必要 Custom Nodes、H3/SAM 模型、FFmpeg、rembg/U2NETP 与 Real-ESRGAN，但不包含 NVIDIA 显卡驱动、云端 API 密钥或用户个人素材。
- WebView2 使用 Tauri `offlineInstaller` 模式；不同 Windows、WebView2 和 NVIDIA 驱动版本仍需扩大兼容性矩阵。
- 图像与视频外部执行器只有在路径、版本、模型和许可证状态均通过诊断后才应启用。
- Electron 仅保留为共享本机桥接契约的回退验证，不是本阶段并行交付包。
- Electron 回退壳改用 AEONQUILL 可见名称后，只有在 AEONQUILL 新 userData 尚无持久内容、旧 `MiaoHui` userData 有持久内容时才继续使用旧目录；它不静默复制、搬移或删除。若未来正式切回 Electron，仍须单独完成跨版本人工迁移矩阵。
- MiniMax H3 当前许可存在地域排除、下游接受、显著归属、安全措施与规模化商业授权要求；本包只允许在适用地区内由明确接受协议的用户进行本机阶段测试。
- 本阶段发布清单和随包许可文本用于试装审计，不代表 Python/PyTorch/CUDA 传递依赖、全部模型与处理器已完成 SBOM、法务或公开商业再分发批准。
- 用户项目与模型默认不随卸载删除；应用二进制与用户数据没有自动在线迁移或回滚服务。
- 为避免既有本机数据断链，内部 Tauri identifier 暂时保留为兼容标识 `com.miaohui.desktop`；窗口、程序、安装器、快捷方式和卸载项均使用 AEONQUILL。identifier 迁移必须在后续带数据迁移与回滚的独立任务中完成。

因此，本包只能标注为“AEONQUILL Windows x64 未签名本机阶段测试包”，不能标注为正式商业发行版，也不能标注为无地域限制的公开发行版。
