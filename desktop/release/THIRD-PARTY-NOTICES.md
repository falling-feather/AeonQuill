# AEONQUILL stage-package third-party notices

This file records the distribution boundary of the V0.6 self-signed Windows test package and its split turnkey runtime. It is an audit aid, not a substitute for legal review or the upstream license texts.

## Bundled runtime components

- **Tauri 2 / tauri-plugin-shell / tauri-plugin-dialog / Tauri CLI** — MIT OR Apache-2.0. The web renderer is sandboxed; the main window receives only the native directory-open dialog permission and no shell execution permission.
- **Node.js 22 runtime inside the AEONQUILL bridge sidecar** — Node.js is distributed under the MIT license and incorporates third-party components under their respective terms. A complete upstream Node.js third-party notice review remains required before public commercial distribution.
- **React / React DOM / Lucide React** — MIT.
- **WebView2 offline installer** — distributed through the Tauri Windows offline-installer mode and subject to Microsoft terms.
- **NSIS installer tooling** — zlib/libpng license.

The application source itself is proprietary and no public source-code license grant is implied by this notice.

## Split offline runtime

The main NSIS installer does not contain the large creative runtime. The turnkey directory contains fixed, hashed copies of ComfyUI 0.31, portable Python 3.12, PyTorch cu130 packages, the MiniMax H3 Turbo and Impact Pack custom nodes, INT8/FP8 MiniMax H3, SeedVR2, SAM, FFmpeg, rembg/U2NETP and Real-ESRGAN ncnn Vulkan. Corresponding top-level upstream license texts are copied into the runtime `licenses/` directory, and source-form Python projects remain present where applicable.

MiniMax H3 is subject to its Community License, including territory exclusions, downstream acceptance, attribution, acceptable-use and commercial-scale conditions. NVIDIA runtime components and the transitive portable-Python environment remain subject to their own upstream terms. A complete SBOM, transitive notice audit and commercial redistribution review are still required before public distribution.

Cloud credentials, API keys, project databases, personal input/output media, caches, arbitrary custom nodes, unlisted weights, system NVIDIA drivers, PFX files and code-signing private keys are explicitly excluded.

## Stage status

The installer, application and bridge carry a self-signed Authenticode signature with subject `falling feather制作`; this is not a publicly trusted Windows publisher certificate. The package has no auto-updater and is not approved for public commercial release. The split bundle is marked `self-signed-local-test` and requires explicit MiniMax H3 terms acceptance. See `LIMITATIONS.zh-CN.md`, `release-manifest.json`, `offline-release-manifest.json` and the runtime manifest for machine-readable status.
