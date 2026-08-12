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

const log = createLogger("GoogleSTT");

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
  inactivityTimeout = 0,        // Disabled by default — user clicks mic to stop
  stopOnTabHidden = true,
  interimStabilityMs = 1500,    // 1.5 seconds — promote stable interim to final
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
  const startWebSpeechRef = useRef<(() => void) | null>(null);
  const stopWebSpeechRef = useRef<(() => void) | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  const onStartRef = useRef(onStart);
  const onStopRef = useRef(onStop);

  // Interim stability detection refs
  const stabilityTimer = useRef<NodeJS.Timeout | null>(null);
  const lastInterimText = useRef<string>("");

  // Keep refs updated
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onErrorRef.current = onError;
    onStartRef.current = onStart;
    onStopRef.current = onStop;
  }, [onTranscript, onError, onStart, onStop]);

  const webSpeech = useWebSpeechFallback({
    languageCode: config.languageCode || "en-US",
    onTranscript,
    onError,
    onStart: () => {
      usingWebSpeechRef.current = true;
      isListeningRef.current = true;
      setUseWebSpeech(true);
      setIsListening(true);
      onStart?.();
    },
    onStop: () => {
      usingWebSpeechRef.current = false;
      isListeningRef.current = false;
      setUseWebSpeech(false);
      setIsListening(false);
      onStop?.();
    },
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

    log.debug(`⏱️ Interim stable for ${interimStabilityMs}ms → promoting to final: "${text}"`);

    // Clear stability state
    clearStabilityTimer();
    lastInterimText.current = "";

    // Emit as final transcript
    setTranscript(text);
    setInterimTranscript("");
    onTranscriptRef.current?.(text, true);
  }, [interimStabilityMs, clearStabilityTimer]);

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
                // Google sent a real final — use it directly
                clearStabilityTimer();
                lastInterimText.current = "";

                setTranscript(text);
                setInterimTranscript("");
                onTranscriptRef.current?.(text, true);
              } else {
                // Interim transcript — start/reset stability timer
                setInterimTranscript(text);
                onTranscriptRef.current?.(text, false);

                // If text changed, reset the stability timer
                if (text !== lastInterimText.current) {
                  lastInterimText.current = text;
                  clearStabilityTimer();
                  stabilityTimer.current = setTimeout(() => {
                    promoteInterimToFinal(text);
                  }, interimStabilityMs);
                }
                // If text is the same, the existing timer continues counting
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
  }, [wsRef.current, interimStabilityMs, clearStabilityTimer, promoteInterimToFinal, fallbackToWebSpeech]);

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

      // Start audio capture - send chunks to backend via WebSocket
      await audioCapture.current.start((audioData: Uint8Array) => {
        try {
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && isListeningRef.current) {
            // Send audio data as base64 JSON message
            const base64Data = uint8ArrayToBase64(audioData);
            wsRef.current.send(JSON.stringify({
              type: "stt_audio",
              data: base64Data,
            }));
          }
        } catch (err) {
          log.error("Error sending audio data:", err);
        }
      });

      isListeningRef.current = true;
      setIsListening(true);
      onStartRef.current?.();

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
