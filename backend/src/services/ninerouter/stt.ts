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

const log = createLogger("NineRouterSTT");

const MAX_WINDOW_SECONDS = 15;

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

  writeAudio(audioData: Buffer | Uint8Array): void {
    if (!this.isActive) return;

    const chunk = Buffer.from(audioData);
    this.audioChunks.push(chunk);
    this.totalBytes += chunk.length;
  }

  stop(): void {
    this.stopInternal(true);
  }

  getIsActive(): boolean {
    return this.isActive;
  }

  destroy(): void {
    this.stopInternal(true);
  }

  private getModel(): string {
    return this.endpoint?.model || this.config.model || config.ninerouter.sttModel;
  }

  private handleTranscriptionError(err: Error, isFinal: boolean): void {
    if (isSttCredentialError(err.message)) {
      if (!this.credentialErrorReported) {
        this.credentialErrorReported = true;
        this.callbacks.onError(new Error(formatSttSetupError(this.getModel())));
      }
      this.stopInternal(false);
      return;
    }

    if (isFinal) {
      this.callbacks.onError(err);
    } else {
      log.warn("Interim STT transcription failed:", err.message);
    }
  }

  private getMinAudioBytes(): number {
    return Math.floor(this.config.sampleRateHertz * 2 * 0.3);
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

    const pcm = isFinal ? this.getFullBuffer() : this.getWindowBuffer();
    if (pcm.length < this.getMinAudioBytes()) {
      if (isFinal && this.lastTranscript) {
        this.callbacks.onTranscript(this.lastTranscript, true);
      }
      return;
    }

    this.inFlight = true;

    try {
      const text = await this.requestTranscription(pcm);
      if (!text) return;

      if (isFinal) {
        this.callbacks.onTranscript(text, true);
        this.lastTranscript = text;
        return;
      }

      if (this.config.enableInterimResults !== false && text !== this.lastTranscript) {
        this.lastTranscript = text;
        this.callbacks.onTranscript(text, false);
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

    const headers: Record<string, string> = {};
    if (endpoint.apiKey) {
      headers.Authorization = `Bearer ${endpoint.apiKey}`;
    }

    const response = await fetch(endpoint.transcriptionUrl, {
      method: "POST",
      headers,
      body: form,
    });

    if (!response.ok) {
      throw new Error(await parseNineRouterError(response));
    }

    const payload = (await response.json()) as { text?: string };
    return (payload.text || "").trim();
  }

  private stopInternal(runFinal: boolean): void {
    this.isActive = false;
    this.pendingFinal = false;

    if (this.transcribeTimer) {
      clearInterval(this.transcribeTimer);
      this.transcribeTimer = null;
    }

    if (runFinal) {
      void this.transcribeWindow(true).finally(() => {
        this.audioChunks = [];
        this.totalBytes = 0;
        this.lastTranscript = "";
        this.callbacks.onStopped?.();
      });
      return;
    }

    this.audioChunks = [];
    this.totalBytes = 0;
    this.lastTranscript = "";
    this.callbacks.onStopped?.();
  }
}

export function createNineRouterSTTSession(
  sttConfig: NineRouterSTTConfig,
  callbacks: NineRouterSTTCallbacks
): NineRouterSTTSession {
  return new NineRouterSTTSession(sttConfig, callbacks);
}
