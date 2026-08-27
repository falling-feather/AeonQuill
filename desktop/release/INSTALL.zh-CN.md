# 光阴砚 AEONQUILL 0.7.0 Windows 轻量测试包安装说明

本包是面向 Windows x64 的**自签名阶段测试包**。安装器、应用主程序和本机 bridge 均带有 Authenticode 自签名，签名主体为 **falling feather制作**。自签名可以核对制作者标识和文件是否被修改，但不具备受信任 OV/EV 证书或 Microsoft Trusted Signing 的系统信誉，Windows 仍可能显示“未知发布者”。

## 推荐安装

1. 使用同目录的 `release-manifest.json` 与 `SHA256SUMS.txt` 核对安装器 SHA-256；不要从缺失清单的单独 EXE 判断来源。
2. 运行 `AEONQUILL_0.7.0_x64-setup.exe`。已有 D 盘便携安装应继续选择原 `AEONQUILL/App`，安装前先退出正在运行的光阴砚；`UserData` 与同级 `output` 不属于应用覆盖范围。
3. 首次启动会先检查本机桥接和可选创作依赖。图像、像素和项目管理基础能力可直接使用；需要 ComfyUI、MiniMax H3、SeedVR2、去背景或超分时，从应用“工作流中心”查看版本、来源、大小、SHA-256、许可、显存和预计磁盘占用，再按需安装或导入自己的 ComfyUI API JSON。
4. 用户自选输出目录优先；D 盘便携布局未自选时写入安装根同级 `output`。普通当前用户安装则使用应用本机数据区中的 `output`，可在设置中改为任意现存可写目录。

主安装器只自带 Node.js 22 bridge 与 WebView2 离线安装器，**不捆绑** Python、ComfyUI、Custom Nodes、模型权重、FFmpeg/rembg/Real-ESRGAN 运行时或 API Key。这样可保持包体轻量，并让不同显卡用户只下载实际需要的工作流；对应能力在依赖未满足时会明确阻塞，不会伪装为可用。

## 数据与卸载

应用程序与数据分开：卸载器只管理应用文件，不应删除 `UserData`、项目、素材与 output。更新现有 D 盘应用前仍应核对关键数据库与配置清单；任何安装失败都不应以清理用户数据作为重试手段。

本包仍属于带地域和法务限制的本机测试交付，不是获得 Windows 商业信誉、完成完整 SBOM/法务审查或可在全球公开销售的正式商业发行版。详情见 `LIMITATIONS.zh-CN.md` 与 `THIRD-PARTY-NOTICES.md`。
