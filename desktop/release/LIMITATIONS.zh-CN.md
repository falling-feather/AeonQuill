# AEONQUILL V0.3 阶段测试包限制

- 安装包没有 Windows 代码签名，SmartScreen 信誉、企业部署和商店上架尚未完成。
- 不包含自动更新、差分更新、在线回滚或发布灰度渠道。
- 不捆绑 ComfyUI、Python、Custom Nodes、大模型权重或云端 API 密钥。
- WebView2 由 Windows/Tauri 安装策略提供；不同 Windows 与 WebView2 版本仍需扩大兼容性矩阵。
- 图像与视频外部执行器只有在路径、版本、模型和许可证状态均通过诊断后才应启用。
- Electron 仅保留为共享本机桥接契约的回退验证，不是本阶段并行交付包。
- Electron 回退壳改用 AEONQUILL 可见名称后，只有在 AEONQUILL 新 userData 尚无持久内容、旧 `MiaoHui` userData 有持久内容时才继续使用旧目录；它不静默复制、搬移或删除。若未来正式切回 Electron，仍须单独完成跨版本人工迁移矩阵。
- 本阶段发布清单中的许可证状态用于试装审计，不代表所有第三方模型或工作流已取得商业再分发许可。
- 用户项目与模型默认不随卸载删除；应用二进制与用户数据没有自动在线迁移或回滚服务。
- 为避免既有本机数据断链，内部 Tauri identifier 暂时保留为兼容标识 `com.miaohui.desktop`；窗口、程序、安装器、快捷方式和卸载项均使用 AEONQUILL。identifier 迁移必须在后续带数据迁移与回滚的独立任务中完成。

因此，本包只能标注为“AEONQUILL Windows x64 未签名阶段测试包”，不能标注为正式商业发行版。
