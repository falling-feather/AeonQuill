# 光阴砚 AEONQUILL 0.6.0 Windows 测试包安装说明

本包是面向 Windows x64 的**自签名阶段测试包**。安装器、应用主程序和本机 bridge 均带有 Authenticode 自签名，签名主体为 **falling feather制作**。自签名可以核对制作者标识和文件是否被修改，但不具备受信任 OV/EV 证书或 Microsoft Trusted Signing 的系统信誉，Windows 仍可能显示“未知发布者”。

## 推荐安装

1. 使用同目录的 `release-manifest.json` 与 `SHA256SUMS.txt` 核对安装器 SHA-256。
2. 需要完整图像与视频能力时，不要单独运行主 NSIS；请保持“开箱即用版”的目录结构完整，双击 `Install-AEONQUILL-Full.cmd`。
3. 阅读并接受 MiniMax H3 协议。默认在包所在磁盘创建 `AEONQUILL/App`、`AEONQUILL/UserData` 与 `AEONQUILL/output`，不会把 Python、ComfyUI 或模型复制到 C 盘。
4. 安装后不要移动或删除开箱即用版中的 `runtime` 目录；应用将原位使用这套固定运行时。

主安装器自带 Node.js 22 bridge 与 WebView2 离线安装器。开箱即用目录另含 Python 3.12、ComfyUI 0.31、PyTorch cu130、INT8/FP8 H3、SeedVR2、FFmpeg、rembg、SAM 和 Real-ESRGAN，因此无需系统另装 Node.js、Python 或 ComfyUI；仍需兼容的 NVIDIA 驱动与足够磁盘空间。

## 数据与卸载

应用程序与数据分开：卸载器只管理 `App`，不会删除 `UserData`、项目、素材与 output。用户在设置中选择的输出目录会继续优先；未选择时写入安装根同级 `output`。升级安装会保留已有的自选输出目录。

本包仍属于带地域和法务限制的本机测试交付，不是获得 Windows 商业信誉、完成完整 SBOM/法务审查或可在全球公开销售的正式商业发行版。详情见 `LIMITATIONS.zh-CN.md` 与 `THIRD-PARTY-NOTICES.md`。
