# AEONQUILL 0.7.0 轻量按需测试包限制

- 安装器、主程序和 bridge 使用主体为“falling feather制作”的 Authenticode 自签名；它能提供完整性和制作者标识，但不会建立 Windows 公共信任链，SmartScreen 仍可能提示未知发布者。
- 不包含自签名私钥、PFX、受信任 OV/EV 证书、RFC 3161 时间戳凭据、自动更新、差分更新或在线回滚。
- 本包只包含应用框架、Node.js 22 sidecar 与 WebView2 离线安装器；不包含 Python、ComfyUI、PyTorch/CUDA、Custom Nodes、MiniMax H3、SeedVR2、SAM、FFmpeg、rembg/U2NETP、Real-ESRGAN 或其他模型权重。
- 工作流中心展示的版本、来源、大小、哈希、许可、显存和磁盘要求不等于这些依赖已安装。只有下载校验、许可接受、节点复检和模型探测全部通过后，对应能力才会启用；自定义 JSON 仍受节点、路径、网络和输入输出映射门禁。
- 用户项目、数据库、个人素材、生成结果、API 密钥、日志、缓存与浏览器 profile 明确不进入下载包。BYOK 密钥只驻留本次 sidecar 内存，关闭应用后需要重新授权。
- 8 GiB 显存是当前 RTX 4060 质量档的最低目标，不保证所有驱动、系统内存和并发负载都能无降档运行。高质量 720P H3/SeedVR2 工作流属于可选依赖，实际生成可能耗时约 20—30 分钟或更久。
- WebView2 使用 Tauri `offlineInstaller` 模式；不同 Windows、WebView2 和 NVIDIA 驱动版本仍需扩大干净机兼容性矩阵。
- MiniMax H3 当前许可包含地域排除、下游接受、显著归属、安全措施与规模化商业授权要求；只有用户主动选择相关工作流并接受适用许可后才可下载和使用。
- 本包没有完成所有 Node.js/WebView2 传递依赖及可选工作流、模型与处理器的完整 SBOM、法务和公开商业再分发批准。
- 为保持既有数据兼容，Tauri identifier 暂保留 `com.miaohui.desktop`；用户可见名称、安装器、快捷方式和卸载项均为 AEONQUILL。

因此，本包只能标注为“AEONQUILL Windows x64 自签名本机测试包”，不能标注为正式商业发行版、开箱即用完整模型包或无地域限制的公开发行版。
