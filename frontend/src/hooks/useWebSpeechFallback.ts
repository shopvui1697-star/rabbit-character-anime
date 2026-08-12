/**
 * Web Speech API Fallback Hook
 * Provides browser-native speech recognition as fallback when AWS Transcribe fails
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { createLogger } from "@/utils/logger";

const log = createLogger("WebSpeechFallback");

export interface UseWebSpeechFallbackOptions {
  languageCode?: string;
  onTranscript?: (text: string, isFinal: boolean) => void;
  onError?: (error: Error) => void;
  onStart?: () => void;
  onStop?: () => void;
  continuous?: boolean;
  interimResults?: boolean;
}

export interface UseWebSpeechFallbackReturn {
  isListening: boolean;
  transcript: string;
  interimTranscript: string;
  startListening: () => void;
  stopListening: () => void;
  error: Error | null;
  isSupported: boolean;
}

/**
 * Check if Web Speech API is supported
 */
export function isWebSpeechSupported(): boolean {
  return typeof window !== "undefined" && 
         ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);
}

/**
 * Web Speech API fallback hook
 */
export function useWebSpeechFallback({
  languageCode = "en-US",
  onTranscript,
  onError,
  onStart,
  onStop,
  continuous = true,
  interimResults = true,
}: UseWebSpeechFallbackOptions): UseWebSpeechFallbackReturn {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [isSupported] = useState(isWebSpeechSupported());

  const recognitionRef = useRef<any>(null);

  // Initialize recognition
  useEffect(() => {
    if (!isSupported) {
      log.warn("Web Speech API not supported in this browser");
      return;
    }

    try {
      const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
      const recognition = new SpeechRecognition();

      recognition.lang = languageCode;
      recognition.continuous = continuous;
      recognition.interimResults = interimResults;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        log.debug("🎤 Web Speech Recognition started");
        setIsListening(true);
        onStart?.();
      };

      recognition.onresult = (event: any) => {
        let interimText = "";
        let finalText = "";

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result[0].transcript;

          if (result.isFinal) {
            finalText += text;
          } else {
            interimText += text;
          }
        }

        if (finalText) {
          log.debug(`📝 Web Speech final: "${finalText}"`);
          setTranscript(finalText);
          setInterimTranscript("");
          onTranscript?.(finalText, true);
        } else if (interimText) {
          log.debug(`📝 Web Speech interim: "${interimText}"`);
          setInterimTranscript(interimText);
          onTranscript?.(interimText, false);
        }
      };

      recognition.onerror = (event: any) => {
        log.error("Web Speech error:", event.error);
        
        const errorMessage = event.error === "no-speech"
          ? "No speech detected"
          : event.error === "audio-capture"
          ? "Microphone not available"
          : event.error === "not-allowed"
          ? "Microphone permission denied"
          : `Speech recognition error: ${event.error}`;

        const err = new Error(errorMessage);
        setError(err);
        onError?.(err);
      };

      recognition.onend = () => {
        log.debug("🛑 Web Speech Recognition ended");
        setIsListening(false);
        onStop?.();
      };

      recognitionRef.current = recognition;
    } catch (err) {
      log.error("Failed to initialize Web Speech Recognition:", err);
      setError(err instanceof Error ? err : new Error(String(err)));
    }

    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch (e) {
          // Ignore errors during cleanup
        }
      }
    };
  }, [languageCode, continuous, interimResults, onTranscript, onError, onStart, onStop, isSupported]);

  const startListening = useCallback(() => {
    if (!isSupported) {
      const err = new Error("Web Speech API not supported in this browser");
      setError(err);
      onError?.(err);
      return;
    }

    if (!recognitionRef.current || isListening) {
      return;
    }

    try {
      setError(null);
      setTranscript("");
      setInterimTranscript("");
      recognitionRef.current.start();
      log.debug("🎙️ Starting Web Speech Recognition");
    } catch (err) {
      log.error("Failed to start Web Speech Recognition:", err);
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      onError?.(error);
    }
  }, [isSupported, isListening, onError]);

  const stopListening = useCallback(() => {
    if (!recognitionRef.current || !isListening) {
      return;
    }

    try {
      recognitionRef.current.stop();
      log.debug("🛑 Stopping Web Speech Recognition");
    } catch (err) {
      log.error("Failed to stop Web Speech Recognition:", err);
    }
  }, [isListening]);

  return {
    isListening,
    transcript,
    interimTranscript,
    startListening,
    stopListening,
    error,
    isSupported,
  };
}
