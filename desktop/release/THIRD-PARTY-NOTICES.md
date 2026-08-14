# AEONQUILL stage-package third-party notices

This file records the distribution boundary of the V0.3 unsigned Windows test package. It is an audit aid, not a substitute for legal review or the upstream license texts.

## Bundled runtime components

- **Tauri 2 / tauri-plugin-shell / Tauri CLI** — MIT OR Apache-2.0. The web renderer is sandboxed and receives no shell permission.
- **Node.js 22 runtime inside the AEONQUILL bridge sidecar** — Node.js is distributed under the MIT license and incorporates third-party components under their respective terms. A complete upstream Node.js third-party notice review remains required before public commercial distribution.
- **React / React DOM / Lucide React** — MIT.
- **WebView2 bootstrapper** — distributed through the Tauri Windows bootstrapper mode and subject to Microsoft terms.
- **NSIS installer tooling** — zlib/libpng license.

The application source itself is proprietary and no public source-code license grant is implied by this notice.

## Explicitly not bundled

ComfyUI, Python, FFmpeg, rembg, Real-ESRGAN, custom nodes, H3 or other model weights, fonts and cloud API credentials are not part of the main stage installer. Users must supply or configure these components separately, and each external component or model must pass its own source, hash and commercial-license review before it can be redistributed.

## Stage status

The package is unsigned, has no auto-updater, and is not approved for public commercial release. See `LIMITATIONS.zh-CN.md` and `release-manifest.json` for the machine-readable status.
