# AEONQUILL 旗舰产品广告制作回执

- **成片目标**：26 秒，16:9；1920×1080 母版，1280×720 H.264/AAC 交付版。
- **当前状态**：已完成。用户于 2026-08-27 明确批准直接渲染；五镜头主时间线、字幕、旁白、BGM、音效、四个跨镜转场、1080P 母版、720P 发布片和机器质检均已交付。
- **真实产品素材**：项目中心、双层资源库、工作流中心、多智能体制片台、像素模式和当前应用图标均来自本机实际产品截图。
- **渲染方式**：HyperFrames 0.8.16 + 本地 GSAP 3.14.2，顶层与五个分镜均不访问 CDN；所有字体、图片和音频已冻结在项目内。镜头本身没有调用 MiniMax H3，也不会把 UI 动效伪称为 H3 生成视频。
- **音频方式**：Windows SAPI 5 离线普通话旁白；程序化 92 BPM 配乐；48 kHz 双声道总线；发布转码采用 EBU R128 双遍规范化，成片实测 -14.37 LUFS、-1.40 dBTP。
- **检查结果**：HyperFrames 0.8.16 的高密度 `check --at-transitions --samples 15` 为 0 error；运行时与运动断言为 0 error/warning，17/17 当前可见文本检查满足 WCAG AA。新版发现的数字开头 ID、重复媒体发现和坐标系警告已修复；只保留两个不影响渲染的“大型分镜文件”维护提示。最终发布片为 26.1 秒、1280×720、30fps、H.264/AAC 48 kHz 双声道，中段 seek、黑帧、静帧、响度与真峰值全部通过；五个关键时间点抽帧目检通过。
- **可复现入口**：`index.html`、`index.motion.json`、`STORYBOARD.md`、`audio_meta.json`、`.media/manifest.jsonl`、`compositions/frames/`、`scripts/validate-final-video.ps1`、`scripts/test-final-validator.ps1` 与 `scripts/render-final-720p.ps1`。
- **最终母版**：`renders/AEONQUILL-flagship-ad-20260827-151916-master-1080p.mp4`，21,384,571 bytes，SHA-256 `0f2ba3704e3c935255d611ece9986b16b407379e6a7166ad187dca9138956f91`。
- **最终交付片**：`renders/AEONQUILL-flagship-ad-20260827-151916-720p.mp4`，5,310,124 bytes，SHA-256 `ee073da7e089a151005eb06cfe75da61b511b173a4f0da4889fedaaf8b5fbc0f`。
- **质检证据**：`renders/qa/AEONQUILL-flagship-ad-20260827-151916-qa.json`；抽帧联系表位于 `renders/qa/visual/AEONQUILL-flagship-ad-20260827-151916-contact-sheet.png`。审片门已经消费并关闭；后续重新渲染仍必须再次显式传入 `-Approved`。
