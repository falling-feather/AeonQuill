# AEONQUILL stage-package third-party notices

This file records the distribution boundary of the V0.7 lightweight self-signed Windows test package. It is an audit aid, not a substitute for legal review or the upstream license texts.

## Bundled runtime components

- **Tauri 2 / tauri-plugin-shell / tauri-plugin-dialog / Tauri CLI** — MIT OR Apache-2.0. The web renderer is sandboxed; the main window receives only the native directory-open dialog permission and no shell execution permission.
- **Node.js 22 runtime inside the AEONQUILL bridge sidecar** — Node.js is distributed under the MIT license and incorporates third-party components under their respective terms. A complete upstream Node.js third-party notice review remains required before public commercial distribution.
- **React / React DOM / Lucide React** — MIT.
- **WebView2 offline installer** — distributed through the Tauri Windows offline-installer mode and subject to Microsoft terms.
- **NSIS installer tooling** — zlib/libpng license.

The application source itself is proprietary and no public source-code license grant is implied by this notice.

## Optional workflow packs

The lightweight NSIS installer does not contain Python, ComfyUI, PyTorch/CUDA, custom nodes, MiniMax H3, SeedVR2, SAM, FFmpeg, rembg/U2NETP, Real-ESRGAN or model weights. The in-app workflow center may describe fixed optional packs and controlled download sources, but each pack is a separate user-selected acquisition with its own hash, license gate and dependency probe. A package shown in the catalog must not be interpreted as bundled or licensed by this installer.

MiniMax H3 is subject to its Community License, including territory exclusions, downstream acceptance, attribution, acceptable-use and commercial-scale conditions. NVIDIA runtime components and any user-selected portable-Python environment remain subject to their own upstream terms. A complete SBOM, transitive notice audit and commercial redistribution review are still required before publicly redistributing any optional pack.

Cloud credentials, API keys, project databases, personal input/output media, caches, arbitrary custom nodes, unlisted weights, system NVIDIA drivers, PFX files and code-signing private keys are explicitly excluded.

## Optional H3 native-memory add-on

`desktop/runtime/h3-native-memory` contains the unchanged `nodes/minimax_nodes.py` from [kijai/ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes), commit `eaa8fee753faf37d1539804d89a46d3e0f40963d`, with its upstream GPL-3.0 license text and a SHA-256 source lock. The small registration module exposes only the attention-head and feed-forward memory nodes. It is an optional ComfyUI runtime component, not part of the proprietary renderer or bridge; staging requires an explicit `custom_nodes/aeonquill_h3_memory` destination and refuses to overwrite a modified package. It includes no weights and does not upgrade Python dependencies.

## Stage status

The installer, application and bridge carry a self-signed Authenticode signature with subject `falling feather制作`; this is not a publicly trusted Windows publisher certificate. The package has no auto-updater and is not approved for public commercial release. The stage manifest marks the package `self-signed-test-package`; optional H3 downloads require separate explicit terms acceptance. See `LIMITATIONS.zh-CN.md` and `release-manifest.json` for machine-readable status.
