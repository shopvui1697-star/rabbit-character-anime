# Silero VAD model

`silero_vad_v5.onnx` — Silero VAD v5 ONNX graph, from [snakers4/silero-vad](https://github.com/snakers4/silero-vad) (MIT), vendored via `@ricky0123/vad-web@0.0.30`'s bundled copy (also MIT). Used by `../silero-vad.worker.js` — see that file's header comment for the exact input/output tensor contract.

To update: `npm pack @ricky0123/vad-web@<version>`, extract, copy `dist/silero_vad_v5.onnx` here.
