/**
 * Main-thread wrapper around the Silero VAD worker (public/silero-vad.worker.js).
 * See that file's header comment for the model contract and why this exists.
 */

import { createLogger } from "@/utils/logger";

const log = createLogger("SileroVAD");

/** Frame size the Silero v5 ONNX graph was traced for — 32ms @ 16kHz. Fixed, not configurable. */
export const SILERO_FRAME_SAMPLES = 512;

interface PendingEntry {
  resolve: (isSpeech: number) => void;
  reject: (err: Error) => void;
}

class SileroVadClient {
  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;
  private nextId = 0;
  private pending = new Map<number, PendingEntry>();
  private queue: Promise<unknown> = Promise.resolve();
  private failed = false;
  private ready = false;

  /** Idempotent — safe to call on every startListening(); only loads the wasm+model once. */
  async init(): Promise<void> {
    if (this.failed) {
      throw new Error("Silero VAD previously failed to initialize");
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = new Promise<void>((resolve, reject) => {
      let worker: Worker;
      try {
        // type: "module" — the worker uses dynamic import() to load the
        // onnxruntime-web ESM bundle; classic (non-module) workers have had
        // inconsistent dynamic-import support across browsers historically.
        worker = new Worker("/silero-vad.worker.js", { type: "module" });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.worker = worker;

      const handleInitMessage = (event: MessageEvent) => {
        const msg = event.data;
        if (msg.type === "ready") {
          worker.removeEventListener("message", handleInitMessage);
          resolve();
        } else if (msg.type === "error" && msg.id === undefined) {
          worker.removeEventListener("message", handleInitMessage);
          reject(new Error(msg.message));
        }
      };
      worker.addEventListener("message", handleInitMessage);
      worker.addEventListener("error", (err) => {
        reject(new Error(err.message || "Silero VAD worker failed to load"));
      });

      worker.postMessage({ type: "init" });
    });

    try {
      await this.initPromise;
      this.attachResultListener();
      this.ready = true;
      log.debug("✅ Silero VAD ready");
    } catch (err) {
      this.failed = true;
      this.worker?.terminate();
      this.worker = null;
      throw err;
    }

    return this.initPromise;
  }

  private attachResultListener(): void {
    if (!this.worker) return;
    this.worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type !== "result" && msg.type !== "error") return;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.type === "error") entry.reject(new Error(msg.message));
      else entry.resolve(msg.isSpeech);
    };
  }

  /** Reset the model's recurrent state. Call once at the start of each listening session. */
  reset(): void {
    this.worker?.postMessage({ type: "reset" });
  }

  /**
   * Run one SILERO_FRAME_SAMPLES-length frame through the model, returning a
   * 0..1 speech probability. Calls are serialized FIFO regardless of caller
   * concurrency — the model carries recurrent state across frames, so
   * out-of-order or overlapping runs would corrupt future predictions.
   */
  processFrame(frame: Float32Array): Promise<number> {
    if (!this.worker || !this.ready || this.failed) {
      return Promise.reject(new Error("Silero VAD not initialized"));
    }
    const worker = this.worker;
    const dispatch = () =>
      new Promise<number>((resolve, reject) => {
        const id = this.nextId++;
        this.pending.set(id, { resolve, reject });
        const copy = frame.slice(); // fresh, transferable buffer
        worker.postMessage({ type: "process", id, frame: copy }, [copy.buffer]);
      });

    const result = this.queue.then(dispatch, dispatch);
    // Keep the chain alive even after a rejection, so one bad frame doesn't
    // wedge every frame after it — callers still observe their own rejection.
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  isReady(): boolean {
    return this.ready && !this.failed;
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.initPromise = null;
    this.failed = false;
    this.ready = false;
    this.pending.forEach((entry) => entry.reject(new Error("Silero VAD terminated")));
    this.pending.clear();
    this.queue = Promise.resolve();
  }
}

let singleton: SileroVadClient | null = null;

/** Lazily-created, page-lifetime singleton — reused across start/stop listening cycles. */
export function getSileroVadClient(): SileroVadClient {
  if (!singleton) singleton = new SileroVadClient();
  return singleton;
}
