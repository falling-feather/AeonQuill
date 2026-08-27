# AEONQUILL 旗舰产品广告制作回执

- **成片目标**：26 秒，16:9；1920×1080 母版，1280×720 H.264/AAC 交付版。
- **当前状态**：五镜头主时间线、字幕、旁白、BGM、音效与四个跨镜转场已完成；最终 MP4 编码等待用户审片门确认。
- **真实产品素材**：项目中心、双层资源库、工作流中心、多智能体制片台、像素模式和当前应用图标均来自本机实际产品截图。
- **渲染方式**：HyperFrames 0.8.16 + 本地 GSAP 3.14.2，顶层与五个分镜均不访问 CDN；所有字体、图片和音频已冻结在项目内。镜头本身没有调用 MiniMax H3，也不会把 UI 动效伪称为 H3 生成视频。
- **音频方式**：Windows SAPI 5 离线普通话旁白；程序化 92 BPM 配乐；48 kHz 双声道总线；当前测得约 -14.8 LUFS。
- **检查结果**：HyperFrames 0.8.16 的高密度 `check --at-transitions --samples 15` 为 0 error；运行时与运动断言为 0 error/warning，17/17 当前可见文本检查满足 WCAG AA。新版发现的数字开头 ID、重复媒体发现和坐标系警告已修复；只保留三个不影响渲染的“大型分镜文件”维护提示。四个转场均通过跨轨、重叠与双镜头引用验证；16 个全片关键帧及字体子集后的 5 个复核帧已人工检查。
- **可复现入口**：`index.html`、`index.motion.json`、`STORYBOARD.md`、`audio_meta.json`、`.media/manifest.jsonl`、`compositions/frames/` 与 `scripts/render-final-720p.ps1`。
- **审片入口**：后台 Studio 使用 `http://127.0.0.1:3017/#project/aeonquill-flagship-ad`；必须先由用户审片并明确批准，不得因自动检查通过直接渲染。
- **待完成门禁**：用户批准后，以 `scripts/render-final-720p.ps1 -Approved` 生成 CRF 12 的 1080P 高质量母版，再用 Lanczos、x264 slow/CRF 16、AAC 192 kbps 输出 1280×720 交付版；脚本强制检查时长、H.264/AAC、seek、片中黑帧、静帧事件、响度与 SHA-256，并写入 `renders/qa/`。
