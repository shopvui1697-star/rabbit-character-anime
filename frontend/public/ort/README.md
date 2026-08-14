# onnxruntime-web wasm runtime

Vendored from `onnxruntime-web@1.27.0` (MIT), the `/wasm`-only entry point (no WebGL/WebGPU backend):

- `ort.wasm.min.mjs` — ESM runtime entry (`import * as ort from "onnxruntime-web/wasm"`)
- `ort-wasm-simd-threaded.mjs` / `ort-wasm-simd-threaded.wasm` — the actual wasm binary + its Emscripten glue

Used by `../silero-vad.worker.js` for Silero VAD inference. Loaded with `numThreads = 1` (see that worker's init code) — deliberately single-threaded so it doesn't require `SharedArrayBuffer` / cross-origin isolation (COOP/COEP headers), which this app doesn't set up. A single 32ms frame is cheap enough that threading isn't worth the deployment complexity.

To update: `npm pack onnxruntime-web@<version>`, extract, copy the three files above from `dist/`.
