# AEONQUILL 0.6.0 开箱即用测试包限制

- 安装器、主程序和 bridge 使用主体为“falling feather制作”的 Authenticode 自签名；它能提供完整性和制作者标识，但不会建立 Windows 公共信任链，SmartScreen 仍可能提示未知发布者。
- 不包含自签名私钥、PFX、受信任 OV/EV 证书、RFC 3161 时间戳凭据、自动更新、差分更新或在线回滚。
- 主 NSIS 与大型运行时采用同目录拆分交付。运行时固定包含 Python 3.12.10、ComfyUI 0.31.0、PyTorch 2.12.1+cu130、H3/Impact 节点、INT8 与 FP8 H3、SeedVR2、SAM、FFmpeg、rembg/U2NETP 和 Real-ESRGAN；不包含 NVIDIA 显卡驱动。
- 运行时原位使用，移动、删除或改写包内模型会导致校验或功能失败。用户项目、数据库、个人素材、生成结果、API 密钥、日志、缓存与浏览器 profile 明确不进入下载包。
- 8 GiB 显存是当前 RTX 4060 档位的最低目标，不保证所有驱动、系统内存和并发负载都能无降档运行。高质量 720P 工作流可能耗时约 20—30 分钟。
- WebView2 使用 Tauri `offlineInstaller` 模式；不同 Windows、WebView2 和 NVIDIA 驱动版本仍需扩大干净机兼容性矩阵。
- MiniMax H3 当前许可包含地域排除、下游接受、显著归属、安全措施与规模化商业授权要求；仅能由适用地区内明确接受协议的用户使用。
- 本包没有完成所有 Python/PyTorch/CUDA 传递依赖、模型与处理器的完整 SBOM、法务和公开商业再分发批准。
- 为保持既有数据兼容，Tauri identifier 暂保留 `com.miaohui.desktop`；用户可见名称、安装器、快捷方式和卸载项均为 AEONQUILL。

因此，本包只能标注为“AEONQUILL Windows x64 自签名本机测试包”，不能标注为正式商业发行版或无地域限制的公开发行版。
