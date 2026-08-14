/**
 * STT hook — streams mic PCM to backend (NineRouter / Groq Whisper).
 *
 * Standard pipeline:
 *   Mic → shared AudioContext → NLMS AEC (TTS reference, same clock) → PCM stream
 *   Post-AEC VAD (worklet speechLikely) → UI + endpoint (stt_commit)
 *   Backend Whisper → transcripts
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { AudioCaptureManager } from "@/utils/audioUtils";
import { createLogger } from "@/utils/logger";
import { isWebSpeechSupported, useWebSpeechFallback } from "./useWebSpeechFallback";

const log = createLogger("GoogleSTT");

const VAD_RELEASE_MS = 300;
const ENDPOINT_SILENCE_MS = 400;
/** Ignore VAD for mic/AGC settle after capture starts. */
const MIC_WARMUP_MS = 800;
/** Brief pauses between syllables must not reset the utterance. */
const SPEECH_GAP_HOLD_MS = 400;
/** Require sustained speech before marking utterance (blocks single noise blips → Whisper hallucination). */
const SPEECH_SUSTAIN_MS = 100;

class STTInstanceManager {
  private static activeInstance: { stopListening: () => void; id: string } | null = null;

  static register(stopListening: () => void, id: string): void {
    if (this.activeInstance && this.activeInstance.id !== id) {
      this.activeInstance.stopListening();
    }
    this.activeInstance = { stopListening, id };
  }

  static unregister(id: string): void {
    if (this.activeInstance?.id === id) this.activeInstance = null;
  }
}

export interface GoogleSTTConfig {
  languageCode: string;
  sampleRate: number;
  model?: string;
}

export interface UseGoogleSTTOptions {
  config: GoogleSTTConfig;
  wsRef: React.RefObject<WebSocket | null>;
  wsConnected: boolean;
  onTranscript?: (text: string, isFinal: boolean) => void;
  onError?: (error: Error) => void;
  onStart?: () => void;
  onStop?: () => void;
  onVoiceActivity?: (active: boolean) => void;
  /** Returns true while TTS audio is playing — enables barge-in VAD mode. */
  isTtsPlaying?: () => boolean;
  inactivityTimeout?: number;
  stopOnTabHidden?: boolean;
}

export interface UseGoogleSTTReturn {
  isListening: boolean;
  transcript: string;
  interimTranscript: string;
  startListening: () => Promise<void>;
  stopListening: () => void;
  discardUtterance: () => void;
  enterBargeInMode: () => void;
  error: Error | null;
}

function isBackendSttSetupError(message: string): boolean {
  return /no stt credentials|no credentials for provider|invalid api key|gsk_|organization id|groq stt authentication|add .* api key/i.test(
    message
  );
}

function uint8ArrayToBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
  return btoa(binary);
}

function trimTranscript(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function useGoogleSTT({
  config,
  wsRef,
  onTranscript,
  onError,
  onStart,
  onStop,
  onVoiceActivity,
  isTtsPlaying,
  inactivityTimeout = 0,
  stopOnTabHidden = true,
}: UseGoogleSTTOptions): UseGoogleSTTReturn {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [useWebSpeech, setUseWebSpeech] = useState(false);

  const audioCapture = useRef<AudioCaptureManager | null>(null);
  const inactivityTimer = useRef<NodeJS.Timeout | null>(null);
  const instanceId = useRef(`google-stt-${Date.now()}`);
  const isListeningRef = useRef(false);
  const usingWebSpeechRef = useRef(false);
  const webSpeechModeRef = useRef<"off" | "fallback">("off");
  const startWebSpeechRef = useRef<(() => void) | null>(null);
  const stopWebSpeechRef = useRef<(() => void) | null>(null);

  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  const onStartRef = useRef(onStart);
  const onStopRef = useRef(onStop);
  const onVoiceActivityRef = useRef(onVoiceActivity);
  const isTtsPlayingRef = useRef(isTtsPlaying);
  const bargeInModeEnteredRef = useRef(false);

  const endpointTimer = useRef<NodeJS.Timeout | null>(null);
  const vadActiveRef = useRef(false);
  const vadBelowSinceRef = useRef(0);
  const hadSpeechThisUtteranceRef = useRef(false);
  const awaitingFinalRef = useRef(false);
  const micWarmupUntilRef = useRef(0);
  const speechAboveSinceRef = useRef(0);
  const lastSpeechLikelyAtRef = useRef(0);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onErrorRef.current = onError;
    onStartRef.current = onStart;
    onStopRef.current = onStop;
    onVoiceActivityRef.current = onVoiceActivity;
    isTtsPlayingRef.current = isTtsPlaying;
  }, [onTranscript, onError, onStart, onStop, onVoiceActivity, isTtsPlaying]);

  const clearEndpointTimer = useCallback(() => {
    if (endpointTimer.current) {
      clearTimeout(endpointTimer.current);
      endpointTimer.current = null;
    }
  }, []);

  const sendSttDiscard = useCallback(() => {
    try {
      wsRef.current?.send(JSON.stringify({ type: "stt_discard" }));
    } catch {
      /* ignore */
    }
  }, [wsRef]);

  const sendSttCommit = useCallback(() => {
    try {
      wsRef.current?.send(JSON.stringify({ type: "stt_commit" }));
      log.debug("Sent stt_commit");
    } catch {
      /* ignore */
    }
  }, [wsRef]);

  const scheduleEndpoint = useCallback(() => {
    if (!hadSpeechThisUtteranceRef.current) return;
    clearEndpointTimer();
    endpointTimer.current = setTimeout(() => {
      if (!vadActiveRef.current && hadSpeechThisUtteranceRef.current) {
        awaitingFinalRef.current = true;
        sendSttCommit();
        setInterimTranscript("");
      }
    }, ENDPOINT_SILENCE_MS);
  }, [clearEndpointTimer, sendSttCommit]);

  const discardUtterance = useCallback(() => {
    hadSpeechThisUtteranceRef.current = false;
    awaitingFinalRef.current = false;
    bargeInModeEnteredRef.current = false;
    clearEndpointTimer();
    setInterimTranscript("");
    sendSttDiscard();
  }, [clearEndpointTimer, sendSttDiscard]);

  const webSpeech = useWebSpeechFallback({
    languageCode: config.languageCode || "en-US",
    onTranscript: (text, isFinal) => {
      if (webSpeechModeRef.current === "fallback") {
        onTranscriptRef.current?.(text, isFinal);
      }
    },
    onError: (err) => {
      if (webSpeechModeRef.current === "fallback") onErrorRef.current?.(err);
    },
    onStart: () => {
      if (webSpeechModeRef.current === "fallback") {
        usingWebSpeechRef.current = true;
        isListeningRef.current = true;
        setUseWebSpeech(true);
        setIsListening(true);
        onStartRef.current?.();
      }
    },
    onStop: () => {
      if (webSpeechModeRef.current === "fallback") {
        usingWebSpeechRef.current = false;
        isListeningRef.current = false;
        setUseWebSpeech(false);
        setIsListening(false);
        onStopRef.current?.();
      }
      webSpeechModeRef.current = "off";
    },
  });

  useEffect(() => {
    startWebSpeechRef.current = webSpeech.startListening;
    stopWebSpeechRef.current = webSpeech.stopListening;
  }, [webSpeech.startListening, webSpeech.stopListening]);

  const fallbackToWebSpeech = useCallback((reason: string) => {
    if (!isWebSpeechSupported()) return false;
    log.warn(`Backend STT unavailable (${reason}) — Web Speech fallback`);
    webSpeechModeRef.current = "fallback";
    usingWebSpeechRef.current = true;
    setUseWebSpeech(true);
    setError(null);
    startWebSpeechRef.current?.();
    return true;
  }, []);

  const stopListeningInternal = useCallback(
    (sendBackendStop = true) => {
      if (!isListeningRef.current && !usingWebSpeechRef.current) return;

      isListeningRef.current = false;
      clearEndpointTimer();
      hadSpeechThisUtteranceRef.current = false;
      awaitingFinalRef.current = false;

      if (usingWebSpeechRef.current) {
        stopWebSpeechRef.current?.();
        usingWebSpeechRef.current = false;
        STTInstanceManager.unregister(instanceId.current);
        setUseWebSpeech(false);
        setIsListening(false);
        return;
      }

      STTInstanceManager.unregister(instanceId.current);

      if (inactivityTimer.current) {
        clearTimeout(inactivityTimer.current);
        inactivityTimer.current = null;
      }

      if (vadActiveRef.current) {
        vadActiveRef.current = false;
        onVoiceActivityRef.current?.(false);
      }
      vadBelowSinceRef.current = 0;

      audioCapture.current?.stop();
      audioCapture.current = null;

      if (sendBackendStop) {
        try {
          wsRef.current?.send(JSON.stringify({ type: "stt_stop" }));
        } catch {
          /* ignore */
        }
      }

      setIsListening(false);
      onStopRef.current?.();
    },
    [wsRef, clearEndpointTimer]
  );

  const stopListening = useCallback(() => stopListeningInternal(), [stopListeningInternal]);

  useEffect(() => {
    if (!stopOnTabHidden) return;
    const onHide = () => {
      if (document.hidden && isListeningRef.current) stopListeningInternal();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [stopOnTabHidden, stopListeningInternal]);

  useEffect(() => {
    return () => {
      clearEndpointTimer();
      stopListeningInternal();
    };
  }, [stopListeningInternal, clearEndpointTimer]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;

    const handleMessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);
        switch (message.type) {
          case "stt_transcript": {
            const text = trimTranscript((message.text as string) || "");
            const isFinal = Boolean(message.isFinal);
            if (!text) break;

            if (isFinal) {
              clearEndpointTimer();
              awaitingFinalRef.current = false;
              hadSpeechThisUtteranceRef.current = false;
              setTranscript(text);
              setInterimTranscript("");
              onTranscriptRef.current?.(text, true);
            } else if (hadSpeechThisUtteranceRef.current || awaitingFinalRef.current) {
              setInterimTranscript(text);
              onTranscriptRef.current?.(text, false);
            }
            break;
          }
          case "stt_error": {
            const errMsg = (message.error as string) || "Unknown STT error";
            if (isListeningRef.current && !usingWebSpeechRef.current && isBackendSttSetupError(errMsg)) {
              stopListeningInternal(false);
              if (fallbackToWebSpeech(errMsg)) break;
            }
            onErrorRef.current?.(new Error(errMsg));
            break;
          }
        }
      } catch {
        /* ignore */
      }
    };

    ws.addEventListener("message", handleMessage);
    return () => ws.removeEventListener("message", handleMessage);
  }, [wsRef, clearEndpointTimer, fallbackToWebSpeech, stopListeningInternal]);

  const enterBargeInMode = useCallback(() => {
    if (bargeInModeEnteredRef.current) return;
    bargeInModeEnteredRef.current = true;
    audioCapture.current?.enterBargeInMode(3);
    audioCapture.current?.clearAecReference();
    clearEndpointTimer();
  }, [clearEndpointTimer]);

  const startListening = useCallback(async () => {
    if (isListeningRef.current) return;

    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      onErrorRef.current?.(new Error("WebSocket not connected"));
      return;
    }

    STTInstanceManager.register(stopListeningInternal, instanceId.current);

    try {
      setError(null);
      setTranscript("");
      setInterimTranscript("");
      hadSpeechThisUtteranceRef.current = false;
      awaitingFinalRef.current = false;
      vadActiveRef.current = false;
      vadBelowSinceRef.current = 0;
      speechAboveSinceRef.current = 0;
      lastSpeechLikelyAtRef.current = 0;
      micWarmupUntilRef.current = Date.now() + MIC_WARMUP_MS;
      clearEndpointTimer();

      ws.send(
        JSON.stringify({
          type: "stt_start",
          languageCode: config.languageCode || "en-US",
          sampleRate: config.sampleRate || 16000,
          model: config.model,
        })
      );

      audioCapture.current = new AudioCaptureManager({
        sampleRate: config.sampleRate,
        channelCount: 1,
      });

      await audioCapture.current.start((audioData, rms, speechLikely) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !isListeningRef.current) {
          return;
        }

        wsRef.current.send(
          JSON.stringify({
            type: "stt_audio",
            data: uint8ArrayToBase64(audioData),
            rms,
            speechLikely,
          })
        );

        const now = Date.now();
        const inWarmup = now < micWarmupUntilRef.current;
        const ttsPlaying = isTtsPlayingRef.current?.() ?? false;

        if (speechLikely && !inWarmup) {
          lastSpeechLikelyAtRef.current = now;
          if (speechAboveSinceRef.current === 0) speechAboveSinceRef.current = now;
        } else if (!inWarmup && speechAboveSinceRef.current > 0) {
          if (now - lastSpeechLikelyAtRef.current > SPEECH_GAP_HOLD_MS) {
            speechAboveSinceRef.current = 0;
          }
        }

        const bargeCandidate = speechLikely && ttsPlaying && !inWarmup;
        if (bargeCandidate && !bargeInModeEnteredRef.current) {
          enterBargeInMode();
        }

        const newlySustained =
          !inWarmup &&
          speechAboveSinceRef.current > 0 &&
          now - speechAboveSinceRef.current >= SPEECH_SUSTAIN_MS;

        if (newlySustained || bargeCandidate) {
          hadSpeechThisUtteranceRef.current = true;
        }

        const voiceOn =
          hadSpeechThisUtteranceRef.current &&
          (speechLikely || now - lastSpeechLikelyAtRef.current < SPEECH_GAP_HOLD_MS);

        if (voiceOn) {
          vadBelowSinceRef.current = 0;
          if (!vadActiveRef.current) {
            vadActiveRef.current = true;
            onVoiceActivityRef.current?.(true);
            clearEndpointTimer();
          }
        } else if (vadActiveRef.current) {
          if (vadBelowSinceRef.current === 0) vadBelowSinceRef.current = now;
          if (now - vadBelowSinceRef.current >= VAD_RELEASE_MS) {
            vadActiveRef.current = false;
            onVoiceActivityRef.current?.(false);
            if (hadSpeechThisUtteranceRef.current) scheduleEndpoint();
          }
        }
      });

      isListeningRef.current = true;
      setIsListening(true);
      onStartRef.current?.();

      setTimeout(() => {
        if (!isListeningRef.current) return;
        if (!hadSpeechThisUtteranceRef.current) {
          sendSttDiscard();
          speechAboveSinceRef.current = 0;
          if (vadActiveRef.current) {
            vadActiveRef.current = false;
            onVoiceActivityRef.current?.(false);
          }
          setInterimTranscript("");
        }
      }, MIC_WARMUP_MS);
    } catch (err) {
      onErrorRef.current?.(err instanceof Error ? err : new Error(String(err)));
      stopListeningInternal();
    }
  }, [config, wsRef, stopListeningInternal, clearEndpointTimer, scheduleEndpoint, enterBargeInMode, sendSttDiscard]);

  return {
    isListening: useWebSpeech ? webSpeech.isListening : isListening,
    transcript: useWebSpeech ? webSpeech.transcript : transcript,
    interimTranscript: useWebSpeech ? webSpeech.interimTranscript : interimTranscript,
    startListening,
    stopListening,
    discardUtterance,
    enterBargeInMode,
    error: useWebSpeech ? webSpeech.error : error,
  };
}
