# 光阴砚 AEONQUILL 0.6.0 开箱即用版

本目录同时包含 Windows x64 应用安装器和完整本机创作运行时。运行时含 Python、ComfyUI 0.31、PyTorch cu130、MiniMax H3 文生/图生视频、INT8 主模型、FP8 回退模型、SeedVR2 720P 时序超分、SAM 元素选择、FFmpeg、rembg 与 Real-ESRGAN。系统不需另装 Node.js、Python 或 ComfyUI；仍需兼容的 NVIDIA 驱动。

## 安装

1. 把整个目录放到准备长期使用且剩余空间充足的磁盘，例如 `D:\下载\光阴砚AEONQUILL-0.6.0-Windows-x64-开箱即用版`。
2. 保持 `runtime`、安装脚本、清单与 EXE 的相对位置不变。
3. 双击 `Install-AEONQUILL-Full.cmd`，阅读 MiniMax H3 协议后输入 `ACCEPT`。
4. 脚本先校验发布清单、签名主体、安装器和运行时关键文件，再在同一磁盘创建 `AEONQUILL/App`、`AEONQUILL/UserData` 与默认 `AEONQUILL/output`。

默认使用包内大型运行时，不复制到 C 盘。需要显式指定应用根时可运行：

```powershell
.\Install-AEONQUILL-Full.ps1 -InstallBase 'D:\AEONQUILL' -UsePayloadInPlace -MigrateLegacyData -ReplaceExistingApplication
```

只有确认旧 C 盘数据已经不再被其他版本使用时，才额外加 `-RemoveLegacyAfterMigration`。脚本只处理固定 AEONQUILL 数据根，不扫描或删除同盘其他目录。

## 运行边界

- 目标为 Windows x64、NVIDIA GPU；H3 档位最低按 8 GiB 显存和 32 GiB 系统内存设计。
- RTX 4060 8GB 的已验证高质量链路是 1024×576 Base 20 步后经 SeedVR2 输出 1280×720；约需 20 分钟，FP8 回退约 28 分钟。
- 支持文生视频、主体/首帧参考的图生视频，以及兼容、均衡、原生 720P、Base 精修和 SeedVR2 母版等六档预设。
- ComfyUI 按任务启动；队列为空并空闲 300 秒后自动关闭。
- 用户手选输出目录优先；未选择时写入安装根同级 `output`。
- 安装器、主程序和 bridge 的自签名主体为“falling feather制作”，但自签名不等于 Windows 商业受信任证书。

## 数据、许可与完整性

`App` 与 `UserData` 分离，卸载程序不删除项目、配置和任务历史。包内不含任何开发机项目、用户数据库、个人素材、生成结果、API 密钥、日志或缓存。

MiniMax H3 协议排除欧盟、英国、韩国和美国，并要求下游接受使用限制、显著标注、附带许可/NOTICE 及安全措施。协议位于 `runtime/.../licenses/MiniMax-H3-Community-License.txt`。本包仍是自签名本机测试交付，不是完成法务与 Windows 商业信誉的公开商业发行版。

根 `offline-release-manifest.json` 绑定应用、脚本和运行时清单；`SHA256SUMS-offline.txt` 绑定根交付文件；运行时自己的 `runtime-manifest.json` 与 `runtime-SHA256SUMS.txt` 记录固定版本、关键文件和完整树摘要。
