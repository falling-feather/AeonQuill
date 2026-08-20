# AEONQUILL stage-package third-party notices

This file records the distribution boundary of the V0.4 unsigned Windows test package and its optional split offline runtime. It is an audit aid, not a substitute for legal review or the upstream license texts.

## Bundled runtime components

- **Tauri 2 / tauri-plugin-shell / Tauri CLI** — MIT OR Apache-2.0. The web renderer is sandboxed and receives no shell permission.
- **Node.js 22 runtime inside the AEONQUILL bridge sidecar** — Node.js is distributed under the MIT license and incorporates third-party components under their respective terms. A complete upstream Node.js third-party notice review remains required before public commercial distribution.
- **React / React DOM / Lucide React** — MIT.
- **WebView2 offline installer** — distributed through the Tauri Windows offline-installer mode and subject to Microsoft terms.
- **NSIS installer tooling** — zlib/libpng license.

The application source itself is proprietary and no public source-code license grant is implied by this notice.

## Split offline runtime

The main NSIS installer does not contain the large creative runtime. The separately staged full-offline directory contains fixed, hashed copies of ComfyUI, portable Python, PyTorch/CUDA Python packages, the MiniMax H3 Turbo and Impact Pack custom nodes, MiniMax H3/SAM model files, FFmpeg, rembg/U2NETP and Real-ESRGAN ncnn Vulkan. Corresponding top-level upstream license texts are copied into the runtime `licenses/` directory, and source-form Python projects remain present where applicable.

MiniMax H3 is subject to its Community License, including territory exclusions, downstream acceptance, attribution, acceptable-use and commercial-scale conditions. NVIDIA runtime components and the transitive portable-Python environment remain subject to their own upstream terms. A complete SBOM, transitive notice audit and commercial redistribution review are still required before public distribution.

Cloud credentials, API keys, personal input/output media, caches, arbitrary custom nodes, unlisted weights, system NVIDIA drivers and signing certificates are explicitly excluded.

## Stage status

The package is unsigned, has no auto-updater, and is not approved for public commercial release. The split bundle is marked `unsigned-local-stage-only` and requires explicit MiniMax H3 terms acceptance. See `LIMITATIONS.zh-CN.md`, `release-manifest.json`, `offline-release-manifest.json` and the runtime manifest for machine-readable status.
