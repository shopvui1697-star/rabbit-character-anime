/**
 * Google Cloud STT hook - Streams audio via backend WebSocket
 * 
 * Handles real-time speech-to-text using Google Cloud Speech-to-Text.
 * Audio is captured in the browser, sent to the backend via WebSocket,
 * and the backend streams it to Google Cloud STT and returns transcripts.
 * 
 * Includes "interim stability" detection: if an interim transcript stays
 * unchanged for a configurable period, it is promoted to a final transcript.
 * This replaces AWS Transcribe's built-in PartialResultsStability feature.
 * 
 * Provides the same interface as useAWSTranscribe for easy migration.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { AudioCaptureManager } from "@/utils/audioUtils";
import { createLogger } from "@/utils/logger";
import { isWebSpeechSupported, useWebSpeechFallback } from "./useWebSpeechFallback";

import { sanitizeTranscript, isLikelyHallucination } from "@/utils/sttTranscriptGuard";

const log = createLogger("GoogleSTT");

const RMS_SPEECH_THRESHOLD = parseFloat(process.env.NEXT_PUBLIC_STT_RMS_THRESHOLD || "0.012");
const RMS_HANGOVER_MS = parseInt(process.env.NEXT_PUBLIC_STT_RMS_HANGOVER_MS || "900", 10);
const DEFAULT_INTERIM_STABILITY_MS = parseInt(
  process.env.NEXT_PUBLIC_STT_INTERIM_STABILITY_MS || "2500",
  10
);

// Fast VAD (voice activity detection) duration-guard — confirms real speech from raw mic RMS
// well before any STT transcript arrives. Reuses RMS_SPEECH_THRESHOLD above as the energy gate.
const VAD_CONFIRM_MS = parseInt(process.env.NEXT_PUBLIC_VAD_CONFIRM_MS || "200", 10);
const VAD_RELEASE_MS = parseInt(process.env.NEXT_PUBLIC_VAD_RELEASE_MS || "200", 10);

/**
 * Global STT Instance Manager
 * Ensures only one STT session is active at a time
 */
class STTInstanceManager {
  private static activeInstance: {
    stopListening: () => void;
    id: string;
  } | null = null;

  static register(stopListening: () => void, id: string): void {
    if (this.activeInstance && this.activeInstance.id !== id) {
      log.debug(`🔄 Stopping previous STT instance (${this.activeInstance.id})`);
      this.activeInstance.stopListening();
    }
    this.activeInstance = { stopListening, id };
    log.debug(`✅ Registered STT instance: ${id}`);
  }

  static unregister(id: string): void {
    if (this.activeInstance?.id === id) {
      log.debug(`🗑️ Unregistered STT instance: ${id}`);
      this.activeInstance = null;
    }
  }
}

export interface GoogleSTTConfig {
  languageCode: string;   // e.g. "ja-JP"
  sampleRate: number;     // e.g. 16000
  model?: string;         // e.g. "default", "latest_long"
}

export interface UseGoogleSTTOptions {
  config: GoogleSTTConfig;
  /** Reference to the app WebSocket */
  wsRef: React.RefObject<WebSocket | null>;
  /** Whether the WebSocket is connected */
  wsConnected: boolean;
  onTranscript?: (text: string, isFinal: boolean) => void;
  onError?: (error: Error) => void;
  onStart?: () => void;
  onStop?: () => void;
  /**
   * Fast, duration-guarded voice-activity signal computed from raw mic RMS —
   * fires ~VAD_CONFIRM_MS after real speech energy starts, well before any STT
   * transcript arrives. Not available when running on the Web Speech fallback
   * (no raw audio access there).
   */
  onVoiceActivity?: (active: boolean) => void;
  /**
   * Fast Web Speech-derived signal used only to accelerate barge-in detection
   * (duck/early-stop) while NineRouter/Groq is healthy — Web Speech is NOT
   * authoritative in this mode; NineRouter's own transcript still drives final
   * submission via `onTranscript`. Runs in parallel with the NineRouter mic
   * capture (when the browser supports it). Web Speech only becomes
   * authoritative in the exclusive-fallback path (routed through `onTranscript`).
   */
  onFastSignal?: (text: string, isFinal: boolean) => void;
  // Auto-stop configuration
  inactivityTimeout?: number;     // ms of silence before auto-stop (0 = disabled, default: 0)
  stopOnTabHidden?: boolean;      // Stop when tab hidden (default: true)
  // Interim stability: promote unchanged interim to final after this delay (ms)
  interimStabilityMs?: number;    // default: 1500 (1.5 seconds)
}

export interface UseGoogleSTTReturn {
  isListening: boolean;
  transcript: string;
  interimTranscript: string;
  startListening: () => Promise<void>;
  stopListening: () => void;
  error: Error | null;
}

/**
 * Helper: Convert Uint8Array to base64 string
 */
function isBackendSttSetupError(message: string): boolean {
  return /no stt credentials|no credentials for provider|invalid api key|gsk_|organization id|groq stt authentication|add .* api key/i.test(
    message
  );
}

function uint8ArrayToBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

export function useGoogleSTT({
  config,
  wsRef,
  wsConnected,
  onTranscript,
  onError,
  onStart,
  onStop,
  onVoiceActivity,
  onFastSignal,
  inactivityTimeout = 0,        // Disabled by default — user clicks mic to stop
  stopOnTabHidden = true,
  interimStabilityMs = DEFAULT_INTERIM_STABILITY_MS,
}: UseGoogleSTTOptions): UseGoogleSTTReturn {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [useWebSpeech, setUseWebSpeech] = useState(false);

  const audioCapture = useRef<AudioCaptureManager | null>(null);
  const inactivityTimer = useRef<NodeJS.Timeout | null>(null);
  const instanceId = useRef<string>(`google-stt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
  const isListeningRef = useRef(false);
  const usingWebSpeechRef = useRef(false);
  // Role of the Web Speech instance: "fallback" = authoritative (NineRouter unavailable),
  // "assist" = fast signal only in parallel with a healthy NineRouter stream, "off" = not running.
  const webSpeechModeRef = useRef<"off" | "fallback" | "assist">("off");
  const startWebSpeechRef = useRef<(() => void) | null>(null);
  const stopWebSpeechRef = useRef<(() => void) | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  const onStartRef = useRef(onStart);
  const onStopRef = useRef(onStop);
  const onVoiceActivityRef = useRef(onVoiceActivity);
  const onFastSignalRef = useRef(onFastSignal);

  // Interim stability detection refs
  const stabilityTimer = useRef<NodeJS.Timeout | null>(null);
  const lastInterimText = useRef<string>("");
  const lastSpeechChunkMs = useRef(0);
  const hadSpeechEnergyRef = useRef(false);

  // Fast VAD duration-guard refs (see VAD_CONFIRM_MS / VAD_RELEASE_MS above)
  const vadActiveRef = useRef(false);
  const vadAboveSinceRef = useRef(0);
  const vadBelowSinceRef = useRef(0);

  const emitTranscript = useCallback((text: string, isFinal: boolean) => {
    const cleaned = sanitizeTranscript(text, isFinal, hadSpeechEnergyRef.current);
    if (!cleaned) {
      if (isFinal) {
        log.debug(`🚫 Rejected final transcript (hallucination/noise): "${text}"`);
      }
      return false;
    }

    if (isFinal) {
      setTranscript(cleaned);
      setInterimTranscript("");
      onTranscriptRef.current?.(cleaned, true);
    } else {
      setInterimTranscript(cleaned);
      onTranscriptRef.current?.(cleaned, false);
    }
    return true;
  }, []);

  // Keep refs updated
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onErrorRef.current = onError;
    onStartRef.current = onStart;
    onStopRef.current = onStop;
    onVoiceActivityRef.current = onVoiceActivity;
    onFastSignalRef.current = onFastSignal;
  }, [onTranscript, onError, onStart, onStop, onVoiceActivity, onFastSignal]);

  // Web Speech transcript: authoritative in "fallback" mode (routed to onTranscript,
  // same as before), fast-signal-only in "assist" mode (routed to onFastSignal instead).
  const handleWebSpeechTranscript = useCallback((text: string, isFinal: boolean) => {
    if (webSpeechModeRef.current === "fallback") {
      onTranscriptRef.current?.(text, isFinal);
    } else if (webSpeechModeRef.current === "assist") {
      onFastSignalRef.current?.(text, isFinal);
    }
  }, []);

  const handleWebSpeechError = useCallback((err: Error) => {
    if (webSpeechModeRef.current === "fallback") {
      onErrorRef.current?.(err);
    }
    // Assist mode: Web Speech errors are non-fatal — NineRouter stays authoritative
  }, []);

  const handleWebSpeechStart = useCallback(() => {
    if (webSpeechModeRef.current === "fallback") {
      usingWebSpeechRef.current = true;
      isListeningRef.current = true;
      setUseWebSpeech(true);
      setIsListening(true);
      onStartRef.current?.();
    }
    // Assist mode: NineRouter's own onStart already fired — no public state change
  }, []);

  const handleWebSpeechStop = useCallback(() => {
    if (webSpeechModeRef.current === "fallback") {
      usingWebSpeechRef.current = false;
      isListeningRef.current = false;
      setUseWebSpeech(false);
      setIsListening(false);
      onStopRef.current?.();
    }
    webSpeechModeRef.current = "off";
  }, []);

  const webSpeech = useWebSpeechFallback({
    languageCode: config.languageCode || "en-US",
    onTranscript: handleWebSpeechTranscript,
    onError: handleWebSpeechError,
    onStart: handleWebSpeechStart,
    onStop: handleWebSpeechStop,
  });

  useEffect(() => {
    startWebSpeechRef.current = webSpeech.startListening;
    stopWebSpeechRef.current = webSpeech.stopListening;
  }, [webSpeech.startListening, webSpeech.stopListening]);

  const fallbackToWebSpeech = useCallback((reason: string) => {
    if (!isWebSpeechSupported()) {
      log.error("Backend STT unavailable and Web Speech API is not supported");
      return false;
    }

    log.warn(`Backend STT unavailable (${reason}) — falling back to Web Speech API`);
    // Reclassify as authoritative — if an assist instance is already running (started
    // alongside NineRouter), this flips its role; startListening() below is then a no-op.
    webSpeechModeRef.current = "fallback";
    usingWebSpeechRef.current = true;
    setUseWebSpeech(true);
    setError(null);
    setTranscript("");
    setInterimTranscript("");
    startWebSpeechRef.current?.();
    return true;
  }, []);

  // ─── Clear stability timer ───
  const clearStabilityTimer = useCallback(() => {
    if (stabilityTimer.current) {
      clearTimeout(stabilityTimer.current);
      stabilityTimer.current = null;
    }
  }, []);

  // ─── Promote current interim transcript to final ───
  const promoteInterimToFinal = useCallback((text: string) => {
    if (!text || !isListeningRef.current) return;

    if (isLikelyHallucination(text, { isFinal: true, hadSpeechEnergy: hadSpeechEnergyRef.current })) {
      log.debug(`🚫 Skipped interim→final promotion (hallucination): "${text}"`);
      clearStabilityTimer();
      lastInterimText.current = "";
      return;
    }

    if (!hadSpeechEnergyRef.current) {
      log.debug(`🚫 Skipped interim→final promotion (no speech energy): "${text}"`);
      clearStabilityTimer();
      lastInterimText.current = "";
      return;
    }

    log.debug(`⏱️ Interim stable for ${interimStabilityMs}ms → promoting to final: "${text}"`);

    // Clear stability state
    clearStabilityTimer();
    lastInterimText.current = "";
    hadSpeechEnergyRef.current = false;
    lastSpeechChunkMs.current = 0;

    emitTranscript(text, true);
  }, [interimStabilityMs, clearStabilityTimer, emitTranscript]);

  // ─── WebSocket message listener for STT responses ───
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;

    const handleMessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);

        switch (message.type) {
          case "stt_transcript": {
            const text = message.text || "";
            const isFinal = message.isFinal || false;

            if (text) {
              log.debug(`📝 Transcript ${isFinal ? "(final)" : "(interim)"}:`, text);

              // Reset inactivity timer on any speech
              resetInactivityTimer();

              if (isFinal) {
                clearStabilityTimer();
                lastInterimText.current = "";
                emitTranscript(text, true);
              } else {
                if (!emitTranscript(text, false)) break;

                // If text changed, reset the stability timer
                if (text !== lastInterimText.current) {
                  lastInterimText.current = text;
                  clearStabilityTimer();
                  stabilityTimer.current = setTimeout(() => {
                    promoteInterimToFinal(text);
                  }, interimStabilityMs);
                }
              }
            }
            break;
          }

          case "stt_started":
            log.debug("✅ Backend confirmed STT started");
            break;

          case "stt_stopped":
            log.debug("🛑 Backend confirmed STT stopped");
            break;

          case "stt_error": {
            const errMsg = message.error || "Unknown STT error";
            log.error("❌ Backend STT error:", errMsg);

            if (isListeningRef.current && !usingWebSpeechRef.current && isBackendSttSetupError(errMsg)) {
              // If Web Speech is already running as an assist signal, detach it first so
              // stopListeningInternal() below doesn't stop it — calling stop() then start()
              // back-to-back on the same SpeechRecognition object races the browser's async
              // stop lifecycle. fallbackToWebSpeech() reclaims the still-running instance.
              if (webSpeechModeRef.current === "assist") {
                webSpeechModeRef.current = "off";
              }
              stopListeningInternal(false);
              if (fallbackToWebSpeech(errMsg)) {
                break;
              }
            }

            const err = new Error(errMsg);
            setError(err);
            onErrorRef.current?.(err);
            break;
          }
        }
      } catch {
        // Ignore non-JSON messages or parse errors
      }
    };

    ws.addEventListener("message", handleMessage);
    return () => {
      ws.removeEventListener("message", handleMessage);
    };
  }, [wsRef.current, interimStabilityMs, clearStabilityTimer, promoteInterimToFinal, fallbackToWebSpeech, emitTranscript]);

  // ─── Inactivity timer ───
  const resetInactivityTimer = useCallback(() => {
    if (inactivityTimer.current) {
      clearTimeout(inactivityTimer.current);
    }

    if (inactivityTimeout > 0 && isListeningRef.current) {
      inactivityTimer.current = setTimeout(() => {
        // Before stopping, check if there's a pending interim transcript
        if (lastInterimText.current) {
          log.debug("⏱️ Inactivity timeout — promoting pending interim before stop");
          promoteInterimToFinal(lastInterimText.current);
        }
        log.debug("⏱️ Inactivity timeout - stopping STT");
        stopListeningInternal();
      }, inactivityTimeout);
    }
  }, [inactivityTimeout, promoteInterimToFinal]);

  // ─── Stop listening (internal) ───
  const stopListeningInternal = useCallback((sendBackendStop = true) => {
    if (!isListeningRef.current && !usingWebSpeechRef.current) return;

    log.debug("🛑 Stopping STT...");
    isListeningRef.current = false;

    if (usingWebSpeechRef.current) {
      usingWebSpeechRef.current = false;
      stopWebSpeechRef.current?.();
      STTInstanceManager.unregister(instanceId.current);
      return;
    }

    // Unregister from global manager
    STTInstanceManager.unregister(instanceId.current);

    // Clear all timers
    if (inactivityTimer.current) {
      clearTimeout(inactivityTimer.current);
      inactivityTimer.current = null;
    }
    clearStabilityTimer();
    lastInterimText.current = "";
    hadSpeechEnergyRef.current = false;
    lastSpeechChunkMs.current = 0;
    if (vadActiveRef.current) {
      vadActiveRef.current = false;
      onVoiceActivityRef.current?.(false);
    }
    vadAboveSinceRef.current = 0;
    vadBelowSinceRef.current = 0;

    // Stop the parallel Web Speech assist instance, if running
    if (webSpeechModeRef.current === "assist") {
      stopWebSpeechRef.current?.();
      webSpeechModeRef.current = "off";
    }

    // Stop audio capture
    if (audioCapture.current) {
      audioCapture.current.stop();
      audioCapture.current = null;
    }

    // Tell backend to stop STT
    if (sendBackendStop) {
      try {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "stt_stop" }));
        }
      } catch (err) {
        log.error("Error sending stt_stop:", err);
      }
    }

    setIsListening(false);
    onStopRef.current?.();
  }, [wsRef, clearStabilityTimer]);

  // Public stopListening
  const stopListening = useCallback(() => {
    stopListeningInternal();
  }, [stopListeningInternal]);

  // ─── Tab visibility handler ───
  useEffect(() => {
    if (!stopOnTabHidden) return;

    const handleVisibilityChange = () => {
      if (document.hidden && isListeningRef.current) {
        log.debug("👁️ Tab hidden - stopping STT");
        stopListeningInternal();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [stopOnTabHidden, stopListeningInternal]);

  // ─── Cleanup on unmount ───
  useEffect(() => {
    return () => {
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      clearStabilityTimer();
      stopListeningInternal();
    };
  }, [stopListeningInternal, clearStabilityTimer]);

  // ─── Start listening ───
  const startListening = useCallback(async () => {
    if (isListeningRef.current) return;

    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      const err = new Error("WebSocket not connected. Cannot start speech recognition.");
      setError(err);
      onErrorRef.current?.(err);
      return;
    }

    // Register with global manager (stops other instances)
    STTInstanceManager.register(stopListeningInternal, instanceId.current);

    try {
      log.debug("🎙️ Starting Google STT...");
      setError(null);
      setTranscript("");
      setInterimTranscript("");
      lastInterimText.current = "";
      hadSpeechEnergyRef.current = false;
      lastSpeechChunkMs.current = 0;
      vadActiveRef.current = false;
      vadAboveSinceRef.current = 0;
      vadBelowSinceRef.current = 0;
      clearStabilityTimer();

      // Tell backend to start STT stream
      ws.send(JSON.stringify({
        type: "stt_start",
        languageCode: config.languageCode || "en-US",
        sampleRate: config.sampleRate || 16000,
        model: config.model,
      }));

      // Create audio capture manager
      audioCapture.current = new AudioCaptureManager({
        sampleRate: config.sampleRate,
        channelCount: 1,
      });

      // Start audio capture - send chunks to backend via WebSocket (VAD-gated)
      await audioCapture.current.start((audioData: Uint8Array, rms: number) => {
        try {
          if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !isListeningRef.current) {
            return;
          }

          const now = Date.now();
          const isSpeech = rms >= RMS_SPEECH_THRESHOLD;
          if (isSpeech) {
            lastSpeechChunkMs.current = now;
            hadSpeechEnergyRef.current = true;
          }

          // Fast VAD signal (duration-guarded): confirms/releases on sustained
          // RMS above/below threshold, independent of the STT round-trip.
          if (isSpeech) {
            vadBelowSinceRef.current = 0;
            if (vadAboveSinceRef.current === 0) vadAboveSinceRef.current = now;
            if (!vadActiveRef.current && now - vadAboveSinceRef.current >= VAD_CONFIRM_MS) {
              vadActiveRef.current = true;
              onVoiceActivityRef.current?.(true);
            }
          } else {
            vadAboveSinceRef.current = 0;
            if (vadBelowSinceRef.current === 0) vadBelowSinceRef.current = now;
            if (vadActiveRef.current && now - vadBelowSinceRef.current >= VAD_RELEASE_MS) {
              vadActiveRef.current = false;
              onVoiceActivityRef.current?.(false);
            }
          }

          const inHangover = now - lastSpeechChunkMs.current < RMS_HANGOVER_MS;
          if (!isSpeech && !inHangover) {
            return; // Skip silent chunks — reduces Whisper hallucination on noise
          }

          const base64Data = uint8ArrayToBase64(audioData);
          wsRef.current.send(JSON.stringify({
            type: "stt_audio",
            data: base64Data,
            rms,
          }));
        } catch (err) {
          log.error("Error sending audio data:", err);
        }
      });

      isListeningRef.current = true;
      setIsListening(true);
      onStartRef.current?.();

      // Start Web Speech in parallel as a fast assist signal (not authoritative) —
      // only while NineRouter is the active path and a consumer is actually wired up.
      if (onFastSignalRef.current && isWebSpeechSupported()) {
        webSpeechModeRef.current = "assist";
        startWebSpeechRef.current?.();
      }

      // Start inactivity timer (if enabled)
      resetInactivityTimer();

      // NOTE: No frontend auto-refresh needed. The backend's GoogleSTTSession
      // automatically handles the Google 5-minute stream limit by restarting
      // the stream transparently. Audio capture stays uninterrupted.

      log.debug("✅ Google STT started successfully", {
        languageCode: config.languageCode,
        sampleRate: config.sampleRate,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("❌ Failed to start Google STT:", error);

      // Enhanced error messages
      let userMessage = error.message;
      if (error.message.includes("Permission denied") || error.message.includes("not-allowed")) {
        userMessage = "Microphone permission is required. Please check your browser settings.";
      } else if (error.message.includes("NotFoundError")) {
        userMessage = "No microphone found. Please check that a microphone is connected.";
      } else if (error.message.includes("WebSocket")) {
        userMessage = "Cannot connect to backend. Please check that the server is running.";
      }

      const enhancedError = new Error(userMessage);
      enhancedError.stack = error.stack;

      setError(enhancedError);
      onErrorRef.current?.(enhancedError);

      // Cleanup on error
      stopListeningInternal();
    }
  }, [config, wsRef, stopListeningInternal, resetInactivityTimer, clearStabilityTimer]);

  return {
    isListening: useWebSpeech ? webSpeech.isListening : isListening,
    transcript: useWebSpeech ? webSpeech.transcript : transcript,
    interimTranscript: useWebSpeech ? webSpeech.interimTranscript : interimTranscript,
    startListening,
    stopListening,
    error: useWebSpeech ? webSpeech.error : error,
  };
}
