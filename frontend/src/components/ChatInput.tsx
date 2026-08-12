"use client";

import React, { useState, useCallback, useRef, useEffect } from "react";
import type { ConversationStatus } from "@/types";
import { createLogger } from "@/utils/logger";
import styles from "./ChatInput.module.css";

const log = createLogger("ChatInput");

interface ChatInputProps {
  onSendMessage: (text: string) => void | Promise<void>;
  status: ConversationStatus;
  disabled?: boolean;
  // AWS Transcribe voice input props
  isListening?: boolean;
  onStartListening?: () => Promise<void>;
  onStopListening?: () => void;
  interimTranscript?: string;
  voiceDetected?: boolean;
  transcribeError?: Error | null;
}

export function ChatInput({
  onSendMessage,
  status,
  disabled,
  // AWS Transcribe props
  isListening = false,
  onStartListening,
  onStopListening,
  interimTranscript = "",
  voiceDetected = false,
  transcribeError,
}: ChatInputProps) {
  const [input, setInput] = useState("");
  const [isMicSupported, setIsMicSupported] = useState(true);
  
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Check for microphone support (getUserMedia)
  useEffect(() => {
    if (typeof window !== "undefined") {
      const hasMediaDevices = !!navigator?.mediaDevices?.getUserMedia;
      setIsMicSupported(hasMediaDevices);
      
      if (!hasMediaDevices) {
        log.warn("MediaDevices API not supported in this browser");
      } else {
        log.debug("Microphone support detected");
      }
    }
  }, []);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);


  // Toggle AWS Transcribe listening
  const handleMicClick = useCallback(async () => {
    if (isListening) {
      onStopListening?.();
    } else {
      await onStartListening?.();
    }
  }, [isListening, onStartListening, onStopListening]);

  // Handle text send
  const handleSend = useCallback(() => {
    const text = input.trim();
    if (text && !disabled && status === "idle") {
      onSendMessage(text);
      setInput("");
    }
  }, [input, disabled, status, onSendMessage]);

  // Handle key press
  const handleKeyPress = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  // Auto-resize textarea with requestAnimationFrame to avoid layout thrashing
  const resizeTimeoutRef = useRef<number | null>(null);
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const textarea = e.target;
    setInput(textarea.value);

    // Debounce resize with requestAnimationFrame
    if (resizeTimeoutRef.current) {
      cancelAnimationFrame(resizeTimeoutRef.current);
    }
    resizeTimeoutRef.current = requestAnimationFrame(() => {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    });
  }, []);

  const isDisabled = disabled || (status !== "idle" && status !== "speaking" && !isListening);
  
  const placeholder = isListening
    ? interimTranscript || "Listening..."
    : status === "thinking"
    ? "Thinking..."
    : status === "speaking"
    ? "Speaking... (talk to interrupt)"
    : "Type a message...";

  return (
    <div className={styles.container}>
      <textarea
        ref={inputRef}
        className={styles.input}
        value={isListening ? interimTranscript : input}
        onChange={handleChange}
        onKeyDown={handleKeyPress}
        placeholder={placeholder}
        disabled={isDisabled || isListening}
        rows={1}
        readOnly={isListening}
      />
      
      {/* Mic Button (AWS Transcribe) */}
      <button
        className={`${styles.micButton} ${isListening ? styles.micRecording : ""} ${voiceDetected ? styles.micVoiceDetected : ""}`}
        onClick={handleMicClick}
        disabled={disabled || !isMicSupported}
        aria-label={isListening ? "Stop recording" : "Start recording"}
        title={isListening ? "Click to stop" : "Click to speak"}
      >
        <div className={styles.micIconWrapper}>
          {isListening && (
            <>
              <div className={styles.pulseRing}></div>
              <div className={styles.pulseRing2}></div>
            </>
          )}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            className={styles.micIcon}
          >
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
            <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
          </svg>
        </div>
      </button>

      {/* Send Button */}
      {input.trim() && !isListening && (
        <button
          className={styles.sendButton}
          onClick={handleSend}
          disabled={isDisabled || !input.trim()}
          aria-label="Send"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            className={styles.sendIcon}
          >
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      )}

      {/* Error display for Speech Recognition */}
      {transcribeError && (
        <div className={styles.transcribeError}>
          <div style={{ marginBottom: '8px' }}>
            ⚠️ {transcribeError.message}
          </div>
          <div style={{ fontSize: '12px', opacity: 0.8 }}>
            💡 Common fixes:
            <ul style={{ margin: '4px 0', paddingLeft: '20px' }}>
              <li>Check backend is running: <code>npm run dev:backend</code></li>
              <li>Verify AWS credentials in backend/.env</li>
              <li>Test STS endpoint: <code>curl http://localhost:3001/api/transcribe/sts-token</code></li>
              <li>Check browser console for detailed errors</li>
              <li>Refresh page and try again</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
