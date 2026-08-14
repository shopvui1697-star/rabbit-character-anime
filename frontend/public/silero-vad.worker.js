/**
 * Silero VAD (v5) inference worker.
 *
 * Runs the ONNX model in a dedicated Worker so wasm inference never blocks
 * the UI thread — see BARGE_IN_CONFIG.md §7.1.C (v3) for why: the previous
 * pure-RMS-energy VAD (see useGoogleSTT.ts) proved unreliable in real-world
 * testing (phantom words from noise triggering STT, and quiet/soft speech
 * falling under the energy threshold) even after parameter tuning. Silero is
 * a real neural network trained to distinguish speech from noise, at the
 * cost of needing an ONNX runtime (accepted trade-off — CPU is cheap,
 * correctness isn't).
 *
 * Model contract (see @ricky0123/vad-web's models/v5.js, MIT licensed, which
 * this mirrors): input tensors `input` (float32 [1, N] audio frame), `state`
 * (float32 [2,1,128] recurrent state, fed back from the previous call), `sr`
 * (int64 sample rate, fixed at 16000). Output tensors: `output` (speech
 * probability 0..1) and `stateN` (state to feed into the next call). N must
 * be exactly 512 samples (32ms @ 16kHz) — the graph was traced for that
 * frame size.
 *
 * All assets are loaded from same-origin static files (no CDN) —
 * public/ort/ (onnxruntime-web wasm build, MIT licensed) and
 * public/models/silero_vad_v5.onnx (from snakers4/silero-vad, MIT licensed,
 * vendored via @ricky0123/vad-web@0.0.30 — see public/models/README.md).
 */

let ort = null;
let session = null;
let state = null;
let sr = null;
let ready = false;
let initPromise = null;

function getNewState(ortInstance) {
  const zeroes = new Array(2 * 128).fill(0);
  return new ortInstance.Tensor("float32", zeroes, [2, 1, 128]);
}

async function init() {
  ort = await import("/ort/ort.wasm.min.mjs");
  // Single-threaded: avoids requiring SharedArrayBuffer / cross-origin
  // isolation (COOP/COEP headers), which this app does not set up. A single
  // 512-sample frame is cheap enough that threading isn't worth the
  // deployment complexity.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = "/ort/";

  const modelResponse = await fetch("/models/silero_vad_v5.onnx");
  if (!modelResponse.ok) {
    throw new Error(`Failed to fetch Silero VAD model: HTTP ${modelResponse.status}`);
  }
  const modelArrayBuffer = await modelResponse.arrayBuffer();
  session = await ort.InferenceSession.create(modelArrayBuffer, {
    executionProviders: ["wasm"],
  });
  sr = new ort.Tensor("int64", [16000n]);
  state = getNewState(ort);
  ready = true;
}

async function processFrame(frame) {
  const input = new ort.Tensor("float32", frame, [1, frame.length]);
  const out = await session.run({ input, state, sr });
  if (!out.stateN) throw new Error("Silero VAD: model returned no state");
  state = out.stateN;
  if (!out.output || typeof out.output.data[0] !== "number") {
    throw new Error("Silero VAD: model returned no output");
  }
  return out.output.data[0];
}

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === "init") {
      if (!initPromise) initPromise = init();
      await initPromise;
      self.postMessage({ type: "ready" });
    } else if (msg.type === "reset") {
      if (ort) state = getNewState(ort);
    } else if (msg.type === "process") {
      if (!ready) throw new Error("Silero VAD worker: process called before init completed");
      const isSpeech = await processFrame(msg.frame);
      self.postMessage({ type: "result", id: msg.id, isSpeech });
    }
  } catch (err) {
    self.postMessage({
      type: "error",
      id: msg.id,
      message: err && err.message ? err.message : String(err),
    });
  }
};
