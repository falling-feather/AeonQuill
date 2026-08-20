# AEONQUILL V0.4.0 完整离线阶段包

本目录同时包含 AEONQUILL Windows x64 应用安装器与固定版本的本机创作运行时。运行时包含 ComfyUI、便携 Python、PyTorch CUDA、当前产品所需自定义节点、MiniMax H3 文生/图生视频模型、SAM、FFmpeg、rembg/U2NETP 与 Real-ESRGAN。系统无需另外安装 Node.js 或 Python；仍需要兼容的 NVIDIA 显卡驱动。

## 安装

1. 保持本目录结构完整，不要单独移动 `runtime`、安装脚本或 EXE。
2. 双击 `Install-AEONQUILL-Full.cmd`。
3. 阅读 MiniMax H3 许可提示；确认位于适用地区并接受协议后输入 `ACCEPT`。
4. 安装脚本会先校验根发布清单绑定的安装器、脚本和运行时清单，再校验关键模型/执行器；随后把 50.28 GiB 运行时复制到当前用户应用数据目录、写入受控配置、静默安装应用本体并启动 AEONQUILL。

若只想在当前目录原位使用运行时，可在 PowerShell 中运行：

```powershell
.\Install-AEONQUILL-Full.ps1 -UsePayloadInPlace
```

原位模式不会复制大型模型，但移动或删除本目录会使视频与模型型图片处理失效。默认复制模式更适合稳定测试。

## 运行边界

- 目标平台：Windows x64、NVIDIA GPU；H3 档位最低按 8 GiB 显存设计。
- ComfyUI 按任务启动，空闲 300 秒且队列为空时由 AEONQUILL 自动关闭。
- 应用本体、Node 22 bridge、Python、ComfyUI、H3/SAM 模型和本地图片处理器均来自包内固定清单。
- NVIDIA 驱动属于系统级依赖，不在包内静默安装。
- 当前包未签名，Windows 可能显示 SmartScreen 提示。

## 许可边界

这是本机阶段测试包，不是已完成法务、代码签名、全球地域控制和安全运营体系的正式商业发行版。

MiniMax H3 的当前协议将欧盟、英国、韩国和美国列为排除地区，并要求下游用户接受使用限制、产品显著标注 MiniMax H3、附带许可证/NOTICE 及配置合理安全措施。完整协议位于运行时的 `licenses/MiniMax-H3-Community-License.txt`。ComfyUI 与 Impact Pack 为 GPL-3.0，源码随 Python 文件一并提供；其他组件的许可文本也在 `licenses` 目录。

## 完整性

- 根目录 `offline-release-manifest.json` 绑定应用安装器与运行时树。
- 运行时 `runtime-manifest.json` 记录固定版本、关键文件和许可边界。
- 当前运行时包含 63,232 个文件、53,988,054,927 bytes，树摘要为 `4c4945aa239bd25e443e5864ad68640aa7d23df1265709df0b764e3524ec488b`。
- `runtime-SHA256SUMS.txt` 覆盖运行时全部文件；默认安装会校验发布绑定项与关键文件，开发验收可执行全量 63,232 文件校验。
