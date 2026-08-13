/**
 * AudioWorklet processor for audio capture, acoustic echo cancellation, and PCM conversion
 *
 * Key design: Buffers RAW audio at source sample rate, then resamples
 * the entire batch in one shot. This avoids:
 *   1. Frame-boundary artifacts from per-frame resampling
 *   2. Excessive postMessage calls (375/s → ~10/s)
 *   3. Stale buffer references (inputData is copied immediately)
 *
 * Output: 100ms chunks of 16kHz PCM16 audio (1600 samples = 3200 bytes)
 *
 * --- Acoustic Echo Cancellation (AEC) ---
 * The main thread relays the exact samples of TTS audio as it starts playing
 * (see audioUnlock.ts `onPlaybackReference`), tagged with a `startTime` on
 * THIS processor's own AudioContext clock (`currentTime`). Each `process()`
 * call drains any pending reference chunks into a ring buffer based on how
 * much real time has elapsed since each chunk started playing — so the ring
 * buffer always reflects "what's audible right now," not "what was queued."
 *
 * A short-filter NLMS (Normalized Least-Mean-Squares) adaptive filter then
 * predicts the echo component of the raw mic signal from that reference and
 * subtracts it, once per ~100ms flush. This models the DIRECT acoustic
 * coupling path (speaker → mic, dominant on laptops/phones where they're a
 * few inches apart) — it is not a full room-reverb canceller like AEC3, but
 * it is a real adaptive filter with a known reference, independent of
 * whatever the browser's own `echoCancellation` constraint may or may not
 * be doing for audio played via the Web Audio API.
 */

class EchoCanceller {
  constructor(sampleRate, config) {
    this.sampleRate = sampleRate;
    this.enabled = config.enabled;
    this.tapCount = Math.max(32, config.tapCount | 0);
    this.stepSize = config.stepSize;
    this.leakage = 1e-4;
    this.maxWeight = 8;

    this.minDelaySamples = 0;
    this.maxDelaySamples = Math.max(1, Math.round((config.maxDelayMs / 1000) * sampleRate));
    this.estimatedDelay = Math.round(0.04 * sampleRate); // 40ms initial guess, refined by search
    this.couplingStrength = 0; // 0..1, normalized correlation at the estimated delay
    this.minCouplingToFilter = 0.15;

    this.weights = new Float32Array(this.tapCount);
    this.avgEnergy = 0; // running average of tap-window energy, for the silence gate below
    this.minRelativeEnergy = 0.05; // skip adaptation when energy < 5% of the recent average

    // Reference ring buffer — real-time-synced "what's audible now" (see class doc above)
    this.refBufferLen = Math.max(
      this.tapCount + this.maxDelaySamples + 1024,
      Math.round(config.refBufferSeconds * sampleRate)
    );
    this.refBuffer = new Float32Array(this.refBufferLen);
    this.refWritePos = 0;
    this.refTotalWritten = 0;
    this.pendingChunks = [];

    this.samplesSinceDelaySearch = 0;
    this.delaySearchIntervalSamples = Math.round(0.5 * sampleRate);
  }

  setConfig(config) {
    if (typeof config.enabled === "boolean") this.enabled = config.enabled;
  }

  /** Queue a chunk of reference (TTS) audio that started playing at `startTime` (this processor's currentTime domain). */
  addReferenceChunk(data, startTime) {
    this.pendingChunks.push({ data, startTime, consumed: 0 });
    if (this.pendingChunks.length > 16) this.pendingChunks.shift(); // defensive cap
  }

  /**
   * Drain pending reference chunks into the ring buffer based on elapsed real time.
   * Call every process() tick. Processes chunks in FORWARD (insertion/startTime)
   * order — critical for correctness: at a chunk boundary, the tail of an older
   * chunk and the head of a newly-queued one can both have newly-available samples
   * in the same tick, and they must be written into the ring buffer in that same
   * chronological order or the reference signal briefly scrambles right at the
   * boundary, corrupting delay estimation and NLMS convergence around it.
   */
  ingestPending(currentTime) {
    if (this.pendingChunks.length === 0) return;
    const stillPending = [];
    for (let i = 0; i < this.pendingChunks.length; i++) {
      const chunk = this.pendingChunks[i];
      const elapsedSamples = Math.floor((currentTime - chunk.startTime) * this.sampleRate);
      if (elapsedSamples > chunk.consumed) {
        const available = Math.min(chunk.data.length, elapsedSamples);
        for (let s = chunk.consumed; s < available; s++) {
          this.refBuffer[this.refWritePos] = chunk.data[s];
          this.refWritePos = (this.refWritePos + 1) % this.refBufferLen;
          this.refTotalWritten++;
        }
        chunk.consumed = available;
      }
      if (chunk.consumed < chunk.data.length) stillPending.push(chunk);
    }
    this.pendingChunks = stillPending;
  }

  /** Reference sample at absolute (monotonic) sample index, or 0 if out of range / not yet written. */
  refAt(absoluteIndex) {
    if (absoluteIndex < 0 || absoluteIndex >= this.refTotalWritten) return 0;
    const distanceFromNewest = this.refTotalWritten - 1 - absoluteIndex;
    if (distanceFromNewest >= this.refBufferLen) return 0; // fell off the ring already
    let pos = this.refWritePos - 1 - distanceFromNewest;
    pos = ((pos % this.refBufferLen) + this.refBufferLen) % this.refBufferLen;
    return this.refBuffer[pos];
  }

  /** Coarse cross-correlation search for the acoustic+processing delay, re-run periodically (~2x/s). */
  maybeEstimateDelay(recentMic) {
    this.samplesSinceDelaySearch += recentMic.length;
    if (this.samplesSinceDelaySearch < this.delaySearchIntervalSamples) return;
    this.samplesSinceDelaySearch = 0;

    if (this.refTotalWritten < this.maxDelaySamples + recentMic.length) {
      this.couplingStrength = 0;
      return;
    }

    const corrWindow = Math.min(recentMic.length, 1024);
    const micStart = recentMic.length - corrWindow;
    // "now" alignment: end of recentMic corresponds to refTotalWritten - 1
    const nowRefIndex = this.refTotalWritten - 1;

    let bestDelay = this.estimatedDelay;
    let bestScore = -1;
    const step = 3; // coarse step to bound search cost

    for (let d = this.minDelaySamples; d <= this.maxDelaySamples; d += step) {
      let dot = 0, micEnergy = 0, refEnergy = 0;
      const base = nowRefIndex - corrWindow - d;
      for (let i = 0; i < corrWindow; i++) {
        const m = recentMic[micStart + i];
        const r = this.refAt(base + i);
        dot += m * r;
        micEnergy += m * m;
        refEnergy += r * r;
      }
      const denom = Math.sqrt(micEnergy * refEnergy) + 1e-8;
      const score = dot / denom;
      if (score > bestScore) {
        bestScore = score;
        bestDelay = d;
      }
    }

    // Hysteresis: small jitter in the estimate from search-step granularity / signal
    // noise must NOT reset the filter every ~0.5s — weights[k] means "coefficient for
    // the sample `estimatedDelay + k` behind now," so changing the delay changes what
    // every weight *means*. Only re-align (and reset weights, since old ones are now
    // meaningless) on a change large enough to look like a real echo-path change.
    const hysteresisSamples = Math.round(0.005 * this.sampleRate); // ~5ms
    const hadLock = this.couplingStrength > 0;
    if (!hadLock || Math.abs(bestDelay - this.estimatedDelay) > hysteresisSamples) {
      if (hadLock) this.weights.fill(0);
      this.estimatedDelay = bestDelay;
    }
    this.couplingStrength = Math.max(0, Math.min(1, bestScore));
  }

  /**
   * Run NLMS echo cancellation over `rawAudio`, returning a cleaned copy.
   * Falls back to passing the input through unchanged when there isn't
   * enough reference history yet, or the estimated coupling is too weak
   * to be worth filtering (e.g. headphones — no acoustic echo path at all).
   */
  cancelEcho(rawAudio, currentTime) {
    this.ingestPending(currentTime);

    if (!this.enabled) return rawAudio;

    this.maybeEstimateDelay(rawAudio);

    if (this.refTotalWritten < this.tapCount + this.maxDelaySamples) return rawAudio;
    if (this.couplingStrength < this.minCouplingToFilter) return rawAudio;

    const output = new Float32Array(rawAudio.length);
    const nowRefIndex = this.refTotalWritten - 1;
    const weights = this.weights;
    const tapCount = this.tapCount;
    const mu = this.stepSize;
    const leakage = this.leakage;
    const maxWeight = this.maxWeight;

    // Base reference index (aligned + delay-shifted) for the OLDEST sample in rawAudio
    const baseRefIndex = nowRefIndex - rawAudio.length - this.estimatedDelay;

    for (let n = 0; n < rawAudio.length; n++) {
      const refIdx0 = baseRefIndex + n; // center tap index for this mic sample

      let predicted = 0;
      for (let k = 0; k < tapCount; k++) {
        predicted += weights[k] * this.refAt(refIdx0 - k);
      }

      const error = rawAudio[n] - predicted;
      output[n] = error;

      // Normalize by the energy of this tap window (recomputed per-sample here —
      // simpler and still cheap relative to the two O(tapCount) loops above).
      let energy = 0;
      for (let k = 0; k < tapCount; k++) {
        const r = this.refAt(refIdx0 - k);
        energy += r * r;
      }

      // Track a slow running average of tap-window energy so we can gate
      // adaptation during near-silence (pauses between words/sentences).
      // Dividing by `energy` directly with only a tiny fixed epsilon is
      // unstable: when the reference goes quiet, energy craters toward 0
      // while `error` doesn't (near-end noise etc.), so `gain = mu*error/energy`
      // blows up and corrupts the weights right as the AI pauses to breathe.
      this.avgEnergy = this.avgEnergy === 0 ? energy : this.avgEnergy * 0.999 + energy * 0.001;
      const energyFloor = Math.max(1e-6, this.avgEnergy * this.minRelativeEnergy);

      if (energy > energyFloor) {
        const gain = (mu * error) / (energy + 1e-6);
        for (let k = 0; k < tapCount; k++) {
          const r = this.refAt(refIdx0 - k);
          let w = weights[k] * (1 - leakage) + gain * r;
          if (w > maxWeight) w = maxWeight;
          else if (w < -maxWeight) w = -maxWeight;
          weights[k] = w;
        }
      }
      // else: reference window is near-silent relative to its recent average —
      // skip adaptation this sample rather than risk a noise-driven weight spike.
    }

    return output;
  }
}

class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this.targetSampleRate = 16000; // AWS Transcribe requires 16kHz

    // Target output size in samples at the TARGET rate (16kHz).
    // 1600 samples @ 16kHz = 100ms — optimal for Japanese speech recognition
    // Provides more phoneme context while maintaining ~10 chunks/s latency.
    // Larger chunks give AWS Transcribe more context for Japanese phonemes.
    this.TARGET_OUTPUT_SAMPLES = 1600;

    // Pre-allocated ring buffer for raw audio at SOURCE sample rate.
    // Sized for up to 4:1 ratio (e.g. 64kHz→16kHz) plus extra frames for safety.
    this.ringBuffer = new Float32Array(this.TARGET_OUTPUT_SAMPLES * 4 + 512);
    this.writePos = 0;

    // AEC tuning comes from processorOptions (set once at construction, since
    // tap count / max delay determine buffer sizes) — falls back to sensible
    // defaults if the node was created without them.
    const aecOptions = (options && options.processorOptions && options.processorOptions.aec) || {};
    this.echoCanceller = new EchoCanceller(sampleRate, {
      enabled: aecOptions.enabled !== false,
      tapCount: aecOptions.tapCount || 512,
      stepSize: aecOptions.stepSize || 0.3,
      maxDelayMs: aecOptions.maxDelayMs || 250,
      refBufferSeconds: aecOptions.refBufferSeconds || 3,
    });

    // Listen for messages from main thread
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "setSampleRate") {
        this.targetSampleRate = msg.sampleRate;
      } else if (msg.type === "aecConfig") {
        this.echoCanceller.setConfig(msg);
      } else if (msg.type === "referenceAudio") {
        this.echoCanceller.addReferenceChunk(msg.data, msg.startTime);
      }
    };
  }

  /**
   * Convert Float32Array audio samples to PCM16 Int16Array
   */
  convertFloat32ToPCM16(float32Array) {
    const pcm16 = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm16;
  }

  /**
   * Resample audio using 4-point cubic interpolation (Catmull-Rom).
   * Better quality than linear interpolation - reduces aliasing artifacts
   * that can confuse speech recognition.
   */
  resampleAudio(samples, sourceSampleRate, targetSampleRate) {
    if (sourceSampleRate === targetSampleRate) {
      return samples;
    }

    const ratio = sourceSampleRate / targetSampleRate;
    const newLength = Math.round(samples.length / ratio);
    const resampled = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const srcIndex = i * ratio;
      const idx = Math.floor(srcIndex);
      const frac = srcIndex - idx;

      // Get 4 surrounding samples (with boundary clamping)
      const s0 = samples[Math.max(0, idx - 1)];
      const s1 = samples[idx];
      const s2 = samples[Math.min(samples.length - 1, idx + 1)];
      const s3 = samples[Math.min(samples.length - 1, idx + 2)];

      // Catmull-Rom cubic interpolation
      const a0 = -0.5 * s0 + 1.5 * s1 - 1.5 * s2 + 0.5 * s3;
      const a1 = s0 - 2.5 * s1 + 2.0 * s2 - 0.5 * s3;
      const a2 = -0.5 * s0 + 0.5 * s2;
      const a3 = s1;

      resampled[i] = a0 * frac * frac * frac + a1 * frac * frac + a2 * frac + a3;

      // Clamp to prevent overflow
      resampled[i] = Math.max(-1, Math.min(1, resampled[i]));
    }

    return resampled;
  }

  /**
   * Flush the ring buffer: run AEC, resample the entire batch, and send to main thread.
   */
  flushBuffer(sourceSampleRate) {
    if (this.writePos === 0) return;

    // Get buffered raw audio (subarray view — no copy needed here)
    const rawAudio = this.ringBuffer.subarray(0, this.writePos);
    this.writePos = 0;

    // Echo-cancel BEFORE resampling — the reference signal is at native rate too,
    // and cancelling at full resolution avoids compounding resampling artifacts.
    const cleanedAudio = this.echoCanceller.cancelEcho(rawAudio, currentTime);

    // Resample the entire batch (no frame-boundary artifacts)
    let output;
    if (sourceSampleRate !== this.targetSampleRate) {
      output = this.resampleAudio(cleanedAudio, sourceSampleRate, this.targetSampleRate);
    } else {
      // Must copy — cleanedAudio may be a view into the reusable ring buffer
      output = new Float32Array(cleanedAudio);
    }

    // Convert to PCM16
    const pcm16 = this.convertFloat32ToPCM16(output);

    // RMS for VAD gating on main thread — computed AFTER echo cancellation,
    // so VAD and Whisper both see the cleaned signal, not raw echo.
    let sumSq = 0;
    for (let i = 0; i < output.length; i++) {
      sumSq += output[i] * output[i];
    }
    const rms = output.length > 0 ? Math.sqrt(sumSq / output.length) : 0;

    // Convert to Uint8Array (little-endian)
    const uint8Array = new Uint8Array(pcm16.length * 2);
    uint8Array.set(new Uint8Array(pcm16.buffer));

    // Send to main thread with ownership transfer
    this.port.postMessage({
      type: 'audioData',
      data: uint8Array,
      rms,
      couplingStrength: this.echoCanceller.couplingStrength,
    }, [uint8Array.buffer]);
  }

  /**
   * Process audio data (called every render quantum — 128 samples)
   */
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0]) {
      // Still drain pending reference chunks even if the mic has no input this
      // quantum, so the ring buffer doesn't fall behind real playback time.
      this.echoCanceller.ingestPending(currentTime);
      return true;
    }

    const inputData = input[0]; // First channel (mono)
    const actualSampleRate = sampleRate;

    // Copy inputData into ring buffer.
    // IMPORTANT: inputData is owned by the audio system and reused after
    // process() returns. We must copy it now, not store a reference.
    if (this.writePos + inputData.length <= this.ringBuffer.length) {
      this.ringBuffer.set(inputData, this.writePos);
      this.writePos += inputData.length;
    } else {
      // Ring buffer full (shouldn't happen) — flush first, then write
      this.flushBuffer(actualSampleRate);
      this.ringBuffer.set(inputData, this.writePos);
      this.writePos += inputData.length;
    }

    // Flush when we have enough raw samples for TARGET_OUTPUT_SAMPLES of resampled audio
    const ratio = actualSampleRate / this.targetSampleRate;
    const rawSamplesNeeded = Math.ceil(this.TARGET_OUTPUT_SAMPLES * ratio);

    if (this.writePos >= rawSamplesNeeded) {
      this.flushBuffer(actualSampleRate);
    }

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
