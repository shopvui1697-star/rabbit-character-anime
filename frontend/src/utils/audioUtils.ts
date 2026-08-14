/**
 * Audio utilities for AWS Transcribe streaming
 * Handles audio capture, PCM conversion, and stream generation
 * Includes RNNoise integration for noise suppression
 */

import { createLogger } from "@/utils/logger";
import { getSharedAudioContext, onPlaybackReference } from "@/utils/audioUnlock";

const log = createLogger("AudioUtils");

// Dynamic import for RNNoise (browser-only, avoid SSR issues)
let loadRnnoise: any = null;
let RnnoiseWorkletNode: any = null;

// Initialize RNNoise imports only in browser
if (typeof window !== 'undefined') {
  import('@sapphi-red/web-noise-suppressor').then((module) => {
    loadRnnoise = module.loadRnnoise;
    RnnoiseWorkletNode = module.RnnoiseWorkletNode;
  });
}

/**
 * Convert Float32Array audio samples to PCM16 (Int16Array)
 */
export function convertFloat32ToPCM16(float32Array: Float32Array): Int16Array {
  const pcm16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    // Clamp to [-1, 1] range
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    // Convert to 16-bit PCM
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm16;
}

/**
 * Resample audio from source sample rate to target sample rate
 * Simple linear interpolation resampling
 */
export function resampleAudio(
  samples: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number
): Float32Array {
  if (sourceSampleRate === targetSampleRate) {
    return samples;
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const newLength = Math.round(samples.length / ratio);
  const resampled = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, samples.length - 1);
    const fraction = srcIndex - srcIndexFloor;

    // Linear interpolation
    resampled[i] =
      samples[srcIndexFloor] * (1 - fraction) +
      samples[srcIndexCeil] * fraction;
  }

  return resampled;
}

/**
 * Audio stream generator for AWS Transcribe
 * Manages audio chunk queue and yields as async iterable
 */
export class AudioStreamGenerator {
  private chunks: Uint8Array[] = [];
  private resolvers: Array<(value: { AudioEvent: { AudioChunk: Uint8Array } } | null) => void> = [];
  private closed = false;

  push(chunk: Uint8Array): void {
    if (this.closed) return;

    if (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver({ AudioEvent: { AudioChunk: chunk } });
    } else {
      this.chunks.push(chunk);
    }
  }

  close(): void {
    this.closed = true;
    // Resolve any pending reads with null
    for (const resolver of this.resolvers) {
      resolver(null);
    }
    this.resolvers = [];
  }

  async *[Symbol.asyncIterator](): AsyncIterator<{
    AudioEvent: { AudioChunk: Uint8Array };
  }> {
    while (true) {
      if (this.chunks.length > 0) {
        yield { AudioEvent: { AudioChunk: this.chunks.shift()! } };
      } else if (this.closed) {
        return;
      } else {
        const chunk = await new Promise<{
          AudioEvent: { AudioChunk: Uint8Array };
        } | null>((resolve) => {
          this.resolvers.push(resolve);
        });
        if (chunk === null) return;
        yield chunk;
      }
    }
  }
}

/**
 * Audio capture configuration
 */
export interface AudioCaptureConfig {
  sampleRate: number;
  channelCount: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export const DEFAULT_AUDIO_CONFIG: AudioCaptureConfig = {
  sampleRate: 16000, // AWS Transcribe requires 16kHz for Japanese
  channelCount: 1, // Mono
  echoCancellation: true,
  noiseSuppression: true, // Use browser's native for better Japanese recognition
  autoGainControl: true, // Helps normalize volume for consistent recognition
};

// 🔧 QUICK TOGGLE: Set to false to disable RNNoise if it affects Japanese transcription
export const ENABLE_RNNOISE = false; // Changed to false for better Japanese recognition

/**
 * Reference-signal acoustic echo cancellation (NLMS adaptive filter, runs inside
 * the AudioWorklet — see audio-processor.worklet.js). Independent of the browser's
 * own `echoCancellation` constraint above: this one has an exact known reference
 * (the TTS PCM as it plays) rather than relying on the browser's own, possibly
 * limited, visibility into Web-Audio-API-based playback.
 */
export const AEC_CONFIG = {
  enabled: (process.env.NEXT_PUBLIC_AEC_ENABLED ?? "true") === "true",
  tapCount: parseInt(process.env.NEXT_PUBLIC_AEC_TAP_COUNT || "512", 10),
  stepSize: parseFloat(process.env.NEXT_PUBLIC_AEC_STEP_SIZE || "0.3"),
  maxDelayMs: parseFloat(process.env.NEXT_PUBLIC_AEC_MAX_DELAY_MS || "250"),
  refBufferSeconds: 3,
};

/**
 * Audio capture manager using Web Audio API
 * Uses modern AudioWorkletNode instead of deprecated ScriptProcessorNode
 * Integrates RNNoise for superior noise suppression
 */
export class AudioCaptureManager {
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processorNode: AudioWorkletNode | null = null;
  private silentGainNode: GainNode | null = null;
  private rnnoiseNode: AudioWorkletNode | null = null;
  private onAudioData: ((data: Uint8Array, rms: number, speechLikely: boolean) => void) | null = null;
  private config: AudioCaptureConfig;
  private useRNNoise: boolean = ENABLE_RNNOISE; // Use global toggle
  private unsubscribeReference: (() => void) | null = null;

  constructor(config: Partial<AudioCaptureConfig> = {}) {
    this.config = { ...DEFAULT_AUDIO_CONFIG, ...config };
  }

  async start(onAudioData: (data: Uint8Array, rms: number, speechLikely: boolean) => void): Promise<void> {
    this.onAudioData = onAudioData;

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: this.config.channelCount,
        echoCancellation: AEC_CONFIG.enabled ? false : this.config.echoCancellation,
        noiseSuppression: this.useRNNoise ? false : this.config.noiseSuppression,
        autoGainControl: this.config.autoGainControl,
        sampleSize: 16,
      },
    });

    // Single shared AudioContext for capture + playback — required so AEC reference
    // startTime and mic process() currentTime share one clock (Web Audio spec).
    this.audioContext = getSharedAudioContext();
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    // Create source node
    this.source = this.audioContext.createMediaStreamSource(this.mediaStream);

    // Load AudioWorklet processor (modern replacement for ScriptProcessorNode)
    try {
      await this.audioContext.audioWorklet.addModule('/audio-processor.worklet.js');
      log.debug("✅ AudioWorklet processor loaded");
    } catch (err) {
      log.error("Failed to load AudioWorklet processor:", err);
      throw new Error("AudioWorklet not supported or failed to load");
    }

    // Create AudioWorklet node for audio processing. AEC tuning (tap count, max
    // delay) is passed via processorOptions since it determines buffer sizes
    // allocated once at construction — see audio-processor.worklet.js.
    this.processorNode = new AudioWorkletNode(this.audioContext, 'audio-capture-processor', {
      processorOptions: { aec: AEC_CONFIG },
    });

    // Set sample rate
    this.processorNode.port.postMessage({
      type: 'setSampleRate',
      sampleRate: this.config.sampleRate,
    });

    // Relay TTS reference with the playback context's startTime and effective gain.
    this.unsubscribeReference = onPlaybackReference((samples, refSampleRate, startTime, gain) => {
      if (!AEC_CONFIG.enabled || !this.processorNode || !this.audioContext) return;
      let resampled =
        refSampleRate === this.audioContext.sampleRate
          ? new Float32Array(samples)
          : resampleAudio(samples, refSampleRate, this.audioContext.sampleRate);
      if (gain !== 1) {
        const scaled = new Float32Array(resampled.length);
        for (let i = 0; i < resampled.length; i++) scaled[i] = resampled[i] * gain;
        resampled = scaled;
      }
      this.processorNode.port.postMessage(
        { type: "referenceAudio", data: resampled, startTime },
        [resampled.buffer]
      );
    });

    // Handle audio data from worklet
    this.processorNode.port.onmessage = (event) => {
      if (event.data.type === 'audioData') {
        const rms = typeof event.data.rms === "number" ? event.data.rms : 0;
        const speechLikely = event.data.speechLikely === true;
        this.onAudioData?.(event.data.data, rms, speechLikely);
      }
    };

    // Try to initialize RNNoise
    let rnnoiseEnabled = false;
    if (this.useRNNoise && typeof window !== 'undefined') {
      try {
        // Check if RNNoise module is loaded
        if (!loadRnnoise || !RnnoiseWorkletNode) {
          log.debug("⏳ Waiting for RNNoise module to load...");
          const module = await import('@sapphi-red/web-noise-suppressor');
          loadRnnoise = module.loadRnnoise;
          RnnoiseWorkletNode = module.RnnoiseWorkletNode;
        }
        
        log.debug("🔧 Loading RNNoise WASM...");
        
        // Load RNNoise WASM binary from local public directory
        const wasmBinary = await loadRnnoise({
          url: '/rnnoise/rnnoise.wasm',
          simdUrl: '/rnnoise/rnnoise-simd.wasm',
        });
        
        log.debug("🔧 Creating RNNoise worklet node...");
        
        // Create RNNoise worklet node
        this.rnnoiseNode = new RnnoiseWorkletNode(this.audioContext, {
          maxChannels: 1,
          wasmBinary,
        });
        
        rnnoiseEnabled = true;
        log.debug("✅ RNNoise loaded successfully");
      } catch (err) {
        log.warn("⚠️ RNNoise failed to load, using direct connection:", err);
        this.rnnoiseNode = null;
      }
    }

    // Connect audio pipeline — route through silent gain (gain=0) to keep the
    // graph alive WITHOUT playing mic audio through speakers (echo source).
    this.silentGainNode = this.audioContext.createGain();
    this.silentGainNode.gain.value = 0;

    if (rnnoiseEnabled && this.rnnoiseNode) {
      // Pipeline: Mic → Source → RNNoise → AudioWorklet → SilentGain
      log.debug("🎵 Audio pipeline: Mic → RNNoise → AudioWorklet (silent output)");
      this.source.connect(this.rnnoiseNode);
      this.rnnoiseNode.connect(this.processorNode);
      this.processorNode.connect(this.silentGainNode);
      this.silentGainNode.connect(this.audioContext.destination);
    } else {
      // Fallback: Direct connection without RNNoise
      log.debug("🎵 Audio pipeline: Mic → AudioWorklet (silent output, no RNNoise)");
      this.source.connect(this.processorNode);
      this.processorNode.connect(this.silentGainNode);
      this.silentGainNode.connect(this.audioContext.destination);
    }

    log.debug("🎤 Audio capture started:", {
      sampleRate: this.audioContext.sampleRate,
      channelCount: this.config.channelCount,
      rnnoiseEnabled,
      browserNoiseSuppression: !this.useRNNoise && this.config.noiseSuppression,
      echoCancellation: this.config.echoCancellation,
      autoGainControl: this.config.autoGainControl,
    });
    
    if (!rnnoiseEnabled && this.useRNNoise) {
      log.warn("⚠️ RNNoise was requested but failed to load. Using browser's noise suppression instead.");
    }
    
    if (!this.useRNNoise) {
      log.debug("ℹ️ RNNoise is DISABLED. Using browser's native audio processing for better Japanese transcription.");
    }
  }

  enterBargeInMode(durationSec = 3): void {
    this.processorNode?.port.postMessage({ type: "bargeInActive", durationSec });
  }

  clearAecReference(): void {
    this.processorNode?.port.postMessage({ type: "clearReference" });
  }

  stop(): void {
    if (this.unsubscribeReference) {
      this.unsubscribeReference();
      this.unsubscribeReference = null;
    }

    if (this.processorNode) {
      this.processorNode.port.onmessage = null;
      this.processorNode.disconnect();
      this.processorNode = null;
      log.debug("🔇 AudioWorklet processor disconnected");
    }

    if (this.silentGainNode) {
      this.silentGainNode.disconnect();
      this.silentGainNode = null;
    }

    if (this.rnnoiseNode) {
      this.rnnoiseNode.disconnect();
      // Cleanup RNNoise resources
      if (typeof (this.rnnoiseNode as any).destroy === 'function') {
        (this.rnnoiseNode as any).destroy();
      }
      this.rnnoiseNode = null;
      log.debug("🔇 RNNoise disconnected and destroyed");
    }

    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }

    if (this.audioContext) {
      // Shared context — disconnect nodes only, do not close
      this.audioContext = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    this.onAudioData = null;
    log.debug("🎤 Audio capture stopped");
  }

  isActive(): boolean {
    return this.mediaStream !== null && this.audioContext !== null;
  }

  isRNNoiseActive(): boolean {
    return this.rnnoiseNode !== null;
  }

  setRNNoiseEnabled(enabled: boolean): void {
    this.useRNNoise = enabled;
    log.debug(`🔧 RNNoise ${enabled ? 'enabled' : 'disabled'} (takes effect on next start)`);
  }
}
