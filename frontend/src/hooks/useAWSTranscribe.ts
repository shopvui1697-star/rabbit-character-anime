/**
 * AWS Transcribe hook - Frontend direct integration
 * Handles real-time speech-to-text with AWS Transcribe Streaming
 * Uses STS temporary credentials for enhanced security
 */

import { useState, useRef, useCallback, useEffect } from "react";
import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
} from "@aws-sdk/client-transcribe-streaming";
import {
  AudioCaptureManager,
  AudioStreamGenerator,
} from "@/utils/audioUtils";
import { createLogger } from "@/utils/logger";
import { TranscribeService } from "@/services/transcribe.service";

const log = createLogger("AWSTranscribe");

/**
 * Global Transcribe Instance Manager
 * Ensures only one transcription session is active at a time
 */
class TranscribeInstanceManager {
  private static activeInstance: {
    stopListening: () => void;
    id: string;
  } | null = null;

  static register(stopListening: () => void, id: string): void {
    // Stop any existing instance
    if (this.activeInstance && this.activeInstance.id !== id) {
      log.debug(`🔄 Stopping previous transcription instance (${this.activeInstance.id})`);
      this.activeInstance.stopListening();
    }

    this.activeInstance = { stopListening, id };
    log.debug(`✅ Registered transcription instance: ${id}`);
  }

  static unregister(id: string): void {
    if (this.activeInstance?.id === id) {
      log.debug(`🗑️ Unregistered transcription instance: ${id}`);
      this.activeInstance = null;
    }
  }

  static getActiveInstanceId(): string | null {
    return this.activeInstance?.id || null;
  }
}

export interface TranscribeConfig {
  languageCode: string;
  sampleRate: number;
  // Use STS tokens from backend (default: true, recommended for production)
  useSTS?: boolean;
  // Custom vocabulary name for domain-specific recognition (movie & gourmet)
  vocabularyName?: string;
  // Legacy mode only (not recommended) - credentials for direct AWS access
  region?: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

export interface UseAWSTranscribeOptions {
  config: TranscribeConfig;
  onTranscript?: (text: string, isFinal: boolean) => void;
  onError?: (error: Error) => void;
  onStart?: () => void;
  onStop?: () => void;
  // Auto-stop configuration
  inactivityTimeout?: number; // Milliseconds of silence before auto-stop (default: 10000)
  stopOnTabHidden?: boolean; // Stop when tab becomes hidden (default: true)
  // Auto-refresh configuration
  sessionRefreshInterval?: number; // Milliseconds before auto-refresh (default: 300000 = 5 minutes)
  enableAutoRefresh?: boolean; // Enable automatic session refresh (default: true)
}

export interface UseAWSTranscribeReturn {
  isListening: boolean;
  transcript: string;
  interimTranscript: string;
  startListening: () => Promise<void>;
  stopListening: () => void;
  error: Error | null;
}

export function useAWSTranscribe({
  config,
  onTranscript,
  onError,
  onStart,
  onStop,
  inactivityTimeout = 10000, // 10 seconds default
  stopOnTabHidden = true,
  sessionRefreshInterval = 300000, // 5 minutes default
  enableAutoRefresh = true,
}: UseAWSTranscribeOptions): UseAWSTranscribeReturn {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState<Error | null>(null);

  const audioCapture = useRef<AudioCaptureManager | null>(null);
  const audioStream = useRef<AudioStreamGenerator | null>(null);
  const transcribeClient = useRef<TranscribeStreamingClient | null>(null);
  const abortController = useRef<AbortController | null>(null);
  const inactivityTimer = useRef<NodeJS.Timeout | null>(null);
  const sessionRefreshTimer = useRef<NodeJS.Timeout | null>(null);
  const sessionStartTime = useRef<number>(0);
  const instanceId = useRef<string>(`transcribe-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);

  // Stop listening function - defined first to avoid circular dependency
  const stopListening = useCallback(() => {
    log.debug("🛑 Stopping AWS Transcribe...");

    // Unregister from global manager
    TranscribeInstanceManager.unregister(instanceId.current);

    // Clear inactivity timer
    if (inactivityTimer.current) {
      clearTimeout(inactivityTimer.current);
      inactivityTimer.current = null;
    }

    // Clear session refresh timer
    if (sessionRefreshTimer.current) {
      clearTimeout(sessionRefreshTimer.current);
      sessionRefreshTimer.current = null;
    }

    // Abort ongoing transcription
    if (abortController.current) {
      abortController.current.abort();
      abortController.current = null;
    }

    // Stop audio capture
    if (audioCapture.current) {
      audioCapture.current.stop();
      audioCapture.current = null;
    }

    // Close audio stream
    if (audioStream.current) {
      audioStream.current.close();
      audioStream.current = null;
    }

    // Destroy transcribe client
    if (transcribeClient.current) {
      transcribeClient.current.destroy();
      transcribeClient.current = null;
    }

    setIsListening(false);
    onStop?.();
  }, [onStop]);

  // Reset inactivity timer
  const resetInactivityTimer = useCallback(() => {
    if (inactivityTimer.current) {
      clearTimeout(inactivityTimer.current);
    }

    if (inactivityTimeout > 0 && isListening) {
      inactivityTimer.current = setTimeout(() => {
        log.debug("⏱️ Inactivity timeout - stopping transcription");
        stopListening();
      }, inactivityTimeout);
    }
  }, [inactivityTimeout, isListening, stopListening]);

  // Handle tab visibility change
  useEffect(() => {
    if (!stopOnTabHidden) return;

    const handleVisibilityChange = () => {
      if (document.hidden && isListening) {
        log.debug("👁️ Tab hidden - stopping transcription");
        stopListening();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isListening, stopOnTabHidden, stopListening]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (inactivityTimer.current) {
        clearTimeout(inactivityTimer.current);
      }
      stopListening();
    };
  }, [stopListening]);

  const startListening = useCallback(async () => {
    if (isListening) return;

    // Register with global manager (will stop any other active instance)
    TranscribeInstanceManager.register(stopListening, instanceId.current);

    try {
      log.debug("🎙️ Starting AWS Transcribe...");
      setError(null);
      setTranscript("");
      setInterimTranscript("");

      // Determine credentials source
      let region: string;
      let credentials: {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
      };

      if (config.useSTS !== false) {
        // Use STS credentials from backend (default and recommended)
        log.debug("🔐 Fetching STS credentials from backend...");
        try {
          const stsToken = await TranscribeService.getSTSToken();
          region = stsToken.region;
          credentials = {
            accessKeyId: stsToken.credentials.accessKeyId,
            secretAccessKey: stsToken.credentials.secretAccessKey,
            sessionToken: stsToken.credentials.sessionToken,
          };
          log.debug("✅ STS credentials obtained successfully");
        } catch (stsError) {
          log.error("Failed to get STS credentials:", stsError);
          throw new Error(
            `Failed to get AWS credentials from backend: ${stsError instanceof Error ? stsError.message : String(stsError)}`
          );
        }
      } else {
        // Fallback to direct credentials (legacy mode, not recommended)
        log.warn("⚠️ Using direct credentials (not recommended for production)");
        
        if (!config.credentials?.accessKeyId || !config.credentials?.secretAccessKey) {
          throw new Error(
            "AWS credentials not configured. Please enable STS mode or set credentials in config."
          );
        }

        if (config.credentials.accessKeyId === "your_access_key_here" ||
            config.credentials.accessKeyId === "YOUR_ACCESS_KEY_HERE") {
          throw new Error(
            "AWS credentials are placeholder values. Please configure proper credentials."
          );
        }

        region = config.region || "ap-northeast-1";
        credentials = {
          accessKeyId: config.credentials.accessKeyId,
          secretAccessKey: config.credentials.secretAccessKey,
          sessionToken: config.credentials.sessionToken,
        };
      }

      // Ensure Japanese language code is used
      const languageCode = config.languageCode || "en-US";
      
      log.debug("📋 AWS Config:", {
        region,
        languageCode: languageCode,
        sampleRate: config.sampleRate,
        credentialType: config.useSTS !== false ? "STS (temporary)" : "Direct (permanent)",
        hasSessionToken: !!credentials.sessionToken,
      });

      // Create abort controller for cleanup
      abortController.current = new AbortController();

      // Create Transcribe client
      transcribeClient.current = new TranscribeStreamingClient({
        region,
        credentials,
      });

      // Create audio stream generator
      audioStream.current = new AudioStreamGenerator();

      // Create audio capture manager
      audioCapture.current = new AudioCaptureManager({
        sampleRate: config.sampleRate,
        channelCount: 1,
      });

      // Start audio capture
      await audioCapture.current.start((audioData) => {
        // Push audio data to stream
        audioStream.current?.push(audioData);
      });

      setIsListening(true);
      onStart?.();

      // Record session start time
      sessionStartTime.current = Date.now();

      // Start inactivity timer
      resetInactivityTimer();

      // Start session refresh timer (if enabled)
      if (enableAutoRefresh && sessionRefreshInterval > 0) {
        sessionRefreshTimer.current = setTimeout(() => {
          const sessionDuration = Date.now() - sessionStartTime.current;
          log.info(`🔄 Auto-refreshing transcription session after ${Math.round(sessionDuration / 1000)}s to maintain quality`);
          
          // Stop and restart to refresh session
          stopListening();
          setTimeout(() => {
            log.debug("🔄 Restarting transcription session...");
            startListening();
          }, 100); // Small delay to ensure clean restart
        }, sessionRefreshInterval);
        
        log.debug(`⏰ Session auto-refresh scheduled in ${sessionRefreshInterval / 1000}s`);
      }

      // Start transcription stream
      // Japanese STT optimization: Use high stability for more accurate final results
      // Trade-off: slightly higher latency but better recognition accuracy
      const command = new StartStreamTranscriptionCommand({
        LanguageCode: languageCode as any,
        MediaEncoding: "pcm",
        MediaSampleRateHertz: config.sampleRate,
        AudioStream: audioStream.current,
        EnablePartialResultsStabilization: true,
        PartialResultsStability: "high", // high stability for better Japanese accuracy
        // Custom vocabulary for movie & gourmet domain (improves recognition of domain terms)
        VocabularyName: config.vocabularyName,
        // Note: LanguageModelName is only for custom CLMs and not available for ja-JP streaming
        // Optimize for Japanese conversation
        VocabularyFilterMethod: undefined, // Disable vocabulary filtering for better Japanese accuracy
        ShowSpeakerLabel: false,
        // Note: NumberOfChannels is only needed when EnableChannelIdentification is true
        // For mono audio (1 channel), omit this parameter entirely
      });

      // Retry logic for transient failures (network issues, throttling)
      const MAX_RETRIES = 3;
      const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

      let response;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          if (attempt > 0) {
            log.debug(`🔄 Retry attempt ${attempt + 1}/${MAX_RETRIES}...`);
          }
          log.debug("🎙️ AWS Transcribe stream starting...");
          response = await transcribeClient.current.send(command);
          break; // Success, exit retry loop
        } catch (retryErr) {
          lastError = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
          const isRetryable =
            lastError.message.includes("throttl") ||
            lastError.message.includes("rate") ||
            lastError.message.includes("network") ||
            lastError.message.includes("timeout") ||
            lastError.message.includes("ECONNRESET") ||
            lastError.message.includes("socket");

          if (!isRetryable || attempt === MAX_RETRIES - 1) {
            throw lastError;
          }

          // Exponential backoff: 100ms, 300ms, 900ms
          const backoffMs = 100 * Math.pow(3, attempt);
          log.warn(`⚠️ Transcribe connection failed, retrying in ${backoffMs}ms...`, lastError.message);
          await delay(backoffMs);
        }
      }

      if (!response?.TranscriptResultStream) {
        throw new Error("No transcript stream returned");
      }

      log.debug("✅ AWS Transcribe connected, SessionId:", response.SessionId);
      log.debug("📋 Transcription settings:", {
        language: languageCode,
        region: config.region,
        partialResultsStabilization: "enabled (medium)",
        mediaEncoding: "pcm",
        sampleRate: config.sampleRate,
        chunkSize: "64ms (1024 samples)",
      });

      // Process transcription results
      for await (const event of response.TranscriptResultStream) {
        // Check if aborted
        if (abortController.current?.signal.aborted) {
          log.debug("🛑 Transcription aborted");
          break;
        }

        if (event.TranscriptEvent?.Transcript?.Results) {
          for (const result of event.TranscriptEvent.Transcript.Results) {
            if (result.Alternatives && result.Alternatives.length > 0) {
              const text = result.Alternatives[0].Transcript || "";
              const isFinal = !result.IsPartial;

              if (text) {
                log.debug(
                  `📝 Transcript ${isFinal ? "(final)" : "(interim)"}:`,
                  text
                );

                // Reset inactivity timer on any speech detected
                resetInactivityTimer();

                if (isFinal) {
                  setTranscript(text);
                  setInterimTranscript("");
                  onTranscript?.(text, true);
                } else {
                  setInterimTranscript(text);
                  onTranscript?.(text, false);
                }
              }
            }
          }
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("❌ AWS Transcribe error:", error);
      
      // Enhanced error messages for common issues
      let userMessage = error.message;
      
      if (error.message.includes("Failed to get AWS credentials from backend")) {
        userMessage = "Cannot connect to backend. Please ensure backend server is running (npm run dev:backend).";
      } else if (error.message.includes("credentials") || error.message.includes("InvalidSignatureException")) {
        userMessage = "AWS credentials are invalid. Please check AWS credentials in backend/.env";
      } else if (error.message.includes("UnrecognizedClientException")) {
        userMessage = "AWS credentials not recognized. Please verify backend AWS configuration.";
      } else if (error.message.includes("BadRequestException")) {
        userMessage = "AWS Transcribe request failed. Check backend configuration and region settings.";
      } else if (error.message.includes("throttl") || error.message.includes("rate")) {
        userMessage = "AWS rate limit exceeded. Please wait a moment and try again.";
      } else if (error.message.includes("network") || error.message.includes("fetch")) {
        userMessage = "Network error. Check your internet connection and backend server.";
      }
      
      const enhancedError = new Error(userMessage);
      enhancedError.stack = error.stack;
      
      log.error("📋 Debug Info:", {
        originalError: error.message,
        errorName: error.name,
        usingSTS: config.useSTS !== false,
        languageCode: config.languageCode,
      });
      
      setError(enhancedError);
      onError?.(enhancedError);
    } finally {
      // Cleanup
      stopListening();
    }
  }, [isListening, config, onTranscript, onError, onStart, stopListening, resetInactivityTimer]);

  return {
    isListening,
    transcript,
    interimTranscript,
    startListening,
    stopListening,
    error,
  };
}
