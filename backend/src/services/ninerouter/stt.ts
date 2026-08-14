/**
 * Speech-to-Text via 9Router /v1/audio/transcriptions
 *
 * 9Router STT is file-based (Whisper-compatible). This session buffers
 * streaming PCM audio from the WebSocket client and periodically sends
 * rolling windows to 9Router for pseudo-real-time transcription.
 */

import { config } from "../../config/index.js";
import { createLogger } from "../../utils/logger.js";
import {
  fetchAvailableSttModels,
  formatSttSetupError,
  isSttCredentialError,
  pcm16ToWav,
  parseNineRouterError,
  resolveSttEndpoint,
  type SttEndpointConfig,
  toIso639Language,
} from "./client.js";
import {
  hasSpeechEnergy,
  sanitizeTranscript,
  STT_MIN_SPEECH_RMS,
} from "../../utils/sttGuard.js";

const log = createLogger("NineRouterSTT");

const MAX_WINDOW_SECONDS = 15;
/** Groq on-demand free/dev tier is 20 RPM — space Whisper calls to stay under it. */
const GROQ_MIN_REQUEST_GAP_MS = 2600;

export interface NineRouterSTTConfig {
  languageCode: string;
  sampleRateHertz: number;
  encoding?: string;
  enableInterimResults?: boolean;
  model?: string;
  useEnhanced?: boolean;
  singleUtterance?: boolean;
}

export interface NineRouterSTTCallbacks {
  onTranscript: (text: string, isFinal: boolean, confidence?: number) => void;
  onError: (error: Error) => void;
  onStarted?: () => void;
  onStopped?: () => void;
}

export class NineRouterSTTSession {
  private config: NineRouterSTTConfig;
  private callbacks: NineRouterSTTCallbacks;
  private isActive = false;
  private audioChunks: Buffer[] = [];
  private totalBytes = 0;
  private lastTranscript = "";
  private transcribeTimer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private pendingFinal = false;
  private endpoint: SttEndpointConfig | null = null;
  private credentialErrorReported = false;
  private hadSpeechEnergy = false;
  private silentTranscribeCount = 0;
  private bytesAtLastTranscribe = 0;
  private lastRequestAt = 0;
  private pausedUntil = 0;
  private abortController: AbortController | null = null;
  private utteranceId = 0;
  /** Set when frontend VAD reports speech-level RMS on any chunk this utterance. */
  private utteranceHadSpeech = false;
  private speechJustStarted = false;
  /** Consecutive speechLikely chunks — avoids Whisper on single noise blip at mic start. */
  private speechLikelyStreak = 0;
  private lastSpeechLikelyAt = 0;
  private sessionStartedAt = 0;
  private static readonly MIC_WARMUP_MS = 800;
  private static readonly SPEECH_GAP_MS = 400;

  constructor(sttConfig: NineRouterSTTConfig, callbacks: NineRouterSTTCallbacks) {
    this.config = sttConfig;
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    if (this.isActive) {
      log.warn("STT session already active, stopping first");
      this.stopInternal(false);
    }

    this.audioChunks = [];
    this.totalBytes = 0;
    this.lastTranscript = "";
    this.pendingFinal = false;
    this.credentialErrorReported = false;
    this.hadSpeechEnergy = false;
    this.utteranceHadSpeech = false;
    this.speechLikelyStreak = 0;
    this.silentTranscribeCount = 0;
    this.bytesAtLastTranscribe = 0;
    this.lastRequestAt = 0;
    this.pausedUntil = 0;
    this.sessionStartedAt = Date.now();
    this.lastSpeechLikelyAt = 0;
    this.utteranceId++;
    this.endpoint = await resolveSttEndpoint(this.config.model);

    if (this.endpoint.source === "ninerouter") {
      const available = await fetchAvailableSttModels();
      if (available.length === 0 && !config.groq.apiKey) {
        throw new Error(formatSttSetupError(this.endpoint.model));
      }
    }

    this.isActive = true;

    this.transcribeTimer = setInterval(() => {
      void this.transcribeWindow(false);
    }, config.ninerouter.sttIntervalMs);

    this.callbacks.onStarted?.();
    log.debug("9Router STT session started", {
      languageCode: this.config.languageCode,
      sampleRate: this.config.sampleRateHertz,
      model: this.endpoint.model,
      source: this.endpoint.source,
    });
  }

  writeAudio(
    audioData: Buffer | Uint8Array,
    rms?: number,
    options?: { speechLikely?: boolean }
  ): void {
    if (!this.isActive) return;

    const now = Date.now();
    const inWarmup = now - this.sessionStartedAt < NineRouterSTTSession.MIC_WARMUP_MS;
    const likely = options?.speechLikely === true;

    if (likely && !inWarmup) {
      if (now - this.lastSpeechLikelyAt > NineRouterSTTSession.SPEECH_GAP_MS) {
        this.speechLikelyStreak = 1;
      } else {
        this.speechLikelyStreak++;
      }
      this.lastSpeechLikelyAt = now;

      if (this.speechLikelyStreak >= 2 || this.utteranceHadSpeech) {
        if (!this.utteranceHadSpeech) this.speechJustStarted = true;
        this.utteranceHadSpeech = true;
        this.hadSpeechEnergy = true;
      }
    }

    const chunk = Buffer.from(audioData);
    this.audioChunks.push(chunk);
    this.totalBytes += chunk.length;

    if (this.speechJustStarted) {
      this.speechJustStarted = false;
      void this.transcribeWindow(false);
    }
  }

  stop(): void {
    this.stopInternal(true);
  }

  getIsActive(): boolean {
    return this.isActive;
  }

  /** Drop buffered PCM without transcribing (e.g. after TTS playback ends). */
  discardBuffer(): void {
    this.utteranceId++;
    this.resetBufferState();
    log.debug("STT buffer discarded");
  }

  /** Run final Whisper on current buffer, then clear for the next utterance. */
  commitUtterance(): void {
    void (async () => {
      while (this.inFlight) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      if (!this.isActive) return;
      if (!this.utteranceHadSpeech) {
        log.debug("🔇 Skipping stt_commit — no VAD-confirmed speech this utterance");
        this.resetBufferState();
        return;
      }
      await this.transcribeWindow(true);
      this.utteranceId++;
      this.resetBufferState();
    })();
  }

  destroy(): void {
    // Disconnect / replace session — drop in-flight work, do not spend another Whisper call
    this.stopInternal(false);
  }

  private getModel(): string {
    return this.endpoint?.model || this.config.model || config.ninerouter.sttModel;
  }

  private resetBufferState(): void {
    this.audioChunks = [];
    this.totalBytes = 0;
    this.lastTranscript = "";
    this.hadSpeechEnergy = false;
    this.utteranceHadSpeech = false;
    this.speechLikelyStreak = 0;
    this.lastSpeechLikelyAt = 0;
    this.silentTranscribeCount = 0;
    this.bytesAtLastTranscribe = 0;
  }

  private parseRetryMs(message: string): number {
    const match = message.match(/try again in (\d+(?:\.\d+)?)s/i);
    if (match) return Math.ceil(parseFloat(match[1]) * 1000) + 250;
    return GROQ_MIN_REQUEST_GAP_MS;
  }

  private handleTranscriptionError(err: Error, isFinal: boolean): void {
    if (err.name === "AbortError" || /aborted/i.test(err.message)) {
      return;
    }

    if (isSttCredentialError(err.message)) {
      if (!this.credentialErrorReported) {
        this.credentialErrorReported = true;
        this.callbacks.onError(new Error(formatSttSetupError(this.getModel())));
      }
      this.stopInternal(false);
      return;
    }

    if (/rate limit/i.test(err.message)) {
      const waitMs = this.parseRetryMs(err.message);
      this.pausedUntil = Date.now() + waitMs;
      log.warn(`STT rate-limited — pausing ${waitMs}ms`);
      return;
    }

    if (isFinal) {
      this.callbacks.onError(err);
    } else {
      log.warn("Interim STT transcription failed:", err.message);
    }
  }

  private getMinAudioBytes(isFinal: boolean): number {
    // Interim: ≥0.5s — balance latency vs Whisper noise hallucination
    const seconds = isFinal ? 0.35 : 0.5;
    return Math.floor(this.config.sampleRateHertz * 2 * seconds);
  }

  private getWindowBuffer(): Buffer {
    const maxBytes = this.config.sampleRateHertz * 2 * MAX_WINDOW_SECONDS;
    let collected = 0;
    const chunks: Buffer[] = [];

    for (let i = this.audioChunks.length - 1; i >= 0; i--) {
      const chunk = this.audioChunks[i];
      if (collected + chunk.length > maxBytes) {
        const start = chunk.length - (maxBytes - collected);
        chunks.unshift(chunk.subarray(start));
        break;
      }
      chunks.unshift(chunk);
      collected += chunk.length;
    }

    return Buffer.concat(chunks);
  }

  private getFullBuffer(): Buffer {
    return Buffer.concat(this.audioChunks);
  }

  private async transcribeWindow(isFinal: boolean): Promise<void> {
    if (!this.isActive || this.inFlight) {
      if (isFinal) this.pendingFinal = true;
      return;
    }

    if (!isFinal && Date.now() < this.pausedUntil) {
      return;
    }

    // Same PCM already sent — don't burn Groq RPM re-transcribing unchanged audio
    if (!isFinal && this.totalBytes <= this.bytesAtLastTranscribe) {
      return;
    }

    if (
      !isFinal &&
      this.endpoint?.source === "groq-direct" &&
      this.lastRequestAt > 0 &&
      Date.now() - this.lastRequestAt < GROQ_MIN_REQUEST_GAP_MS
    ) {
      return;
    }

    const pcm = isFinal ? this.getFullBuffer() : this.getWindowBuffer();
    const minBytes = this.getMinAudioBytes(isFinal);
    if (pcm.length < minBytes) {
      return;
    }

    const speechDetected = hasSpeechEnergy(pcm);
    if (speechDetected) {
      this.hadSpeechEnergy = true;
      this.silentTranscribeCount = 0;
    } else {
      this.silentTranscribeCount++;
      if (!isFinal) {
        log.debug(`🔇 Skipping interim STT — silence (RMS < ${STT_MIN_SPEECH_RMS})`);
        return;
      }
      if (!this.utteranceHadSpeech && !this.hadSpeechEnergy) {
        log.debug("🔇 Skipping final STT — no speech detected in session");
        return;
      }
    }

    // Interim: only call Whisper after post-AEC VAD confirmed speech
    if (!isFinal && !this.utteranceHadSpeech) {
      return;
    }

    this.inFlight = true;
    this.bytesAtLastTranscribe = this.totalBytes;
    const utteranceId = this.utteranceId;

    try {
      const rawText = await this.requestTranscription(pcm);
      if (!this.isActive || utteranceId !== this.utteranceId) return;
      if (!rawText) return;

      const cleaned = sanitizeTranscript(rawText, {
        isFinal,
        hadSpeechEnergy: this.utteranceHadSpeech || speechDetected || this.hadSpeechEnergy,
      });

      if (!cleaned) {
        log.debug(`🚫 Rejected STT output (hallucination/noise): "${rawText}"`);
        return;
      }

      if (isFinal) {
        this.callbacks.onTranscript(cleaned, true);
        this.lastTranscript = cleaned;
        return;
      }

      if (this.config.enableInterimResults !== false && cleaned !== this.lastTranscript) {
        this.lastTranscript = cleaned;
        this.callbacks.onTranscript(cleaned, false);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.handleTranscriptionError(err, isFinal);
    } finally {
      this.inFlight = false;
      if (this.pendingFinal && this.isActive) {
        this.pendingFinal = false;
        void this.transcribeWindow(true);
      }
    }
  }

  private async requestTranscription(pcm: Buffer): Promise<string> {
    const endpoint = this.endpoint || (await resolveSttEndpoint(this.config.model));
    this.endpoint = endpoint;

    const wav = pcm16ToWav(pcm, this.config.sampleRateHertz);
    const form = new FormData();
    form.append("model", endpoint.model);
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
    form.append("language", toIso639Language(this.config.languageCode));
    form.append("response_format", "json");
    form.append("temperature", "0");

    const headers: Record<string, string> = {};
    if (endpoint.apiKey) {
      headers.Authorization = `Bearer ${endpoint.apiKey}`;
    }

    this.abortController?.abort();
    this.abortController = new AbortController();
    this.lastRequestAt = Date.now();

    const response = await fetch(endpoint.transcriptionUrl, {
      method: "POST",
      headers,
      body: form,
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      throw new Error(await parseNineRouterError(response));
    }

    const payload = (await response.json()) as { text?: string };
    return (payload.text || "").trim();
  }

  private stopInternal(runFinal: boolean): void {
    if (this.transcribeTimer) {
      clearInterval(this.transcribeTimer);
      this.transcribeTimer = null;
    }

    const finish = () => {
      this.isActive = false;
      this.pendingFinal = false;
      this.abortController?.abort();
      this.abortController = null;
      this.resetBufferState();
      this.callbacks.onStopped?.();
    };

    if (!runFinal) {
      finish();
      return;
    }

    void (async () => {
      while (this.inFlight) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      try {
        await this.transcribeWindow(true);
      } finally {
        finish();
      }
    })();
  }
}

export function createNineRouterSTTSession(
  sttConfig: NineRouterSTTConfig,
  callbacks: NineRouterSTTCallbacks
): NineRouterSTTSession {
  return new NineRouterSTTSession(sttConfig, callbacks);
}
