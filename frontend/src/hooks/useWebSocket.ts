"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createLogger } from "@/utils/logger";
import archiveStorage from "@/utils/archiveStorage";
import type {
  WSMessage,
  ConversationStatus,
  EmotionType,
  ChatMessage,
  DomainType,
  SaveArchiveMessage,
  FriendMatch,
  // New message types from shared package
  ResponseMessage,
  StatusMessage,
  AudioMessage,
  ErrorMessage,
  VoiceEventMessage,
  // Type guards
  isResponseMessage,
  isStatusMessage,
  isAudioMessage,
  isErrorMessage,
  // Helper functions for creating messages
  createVoiceEventMessage,
} from "@/types";

const log = createLogger("WebSocket");

// Workflow step timing
export interface WorkflowStep {
  step: string;
  name: string;
  nameJa: string;
  durationMs: number;
}

export interface WorkflowTiming {
  steps: WorkflowStep[];
  hasDbSearch: boolean;
  dbSearchTime: number;
  usedTool: boolean;
  totalMs: number;
  // Frontend-measured timings (actual perceived latency)
  timeToFirstResponse?: number;  // Time from send to first text delta
  timeToFirstAudio?: number;     // Time from send to first audio chunk
}

// Legacy timing format (for backwards compatibility)
export interface TimingInfo {
  timings: Array<{ action: string; durationMs: number }>;
  totalMs: number;
}

interface AudioChunk {
  data: string;
  format: string;
  index: number;
  total: number;
  isLast: boolean;
  responseId?: string;  // Used to identify which response this chunk belongs to
  sentence?: string;    // Sentence text for synchronized text+audio display
}

interface UseWebSocketOptions {
  url: string;
  onAudio?: (audioData: string, format: string, responseId?: string, isProtected?: boolean) => void;
  onAudioChunk?: (chunk: AudioChunk) => void;
  onWaiting?: (index: number) => void;  // Play waiting audio before DB search
  onTranscript?: (text: string, isFinal: boolean) => void;  // Real-time transcription
  onBackendResponse?: () => void;  // Called when any backend response arrives (text or audio)
  onItemFocused?: (index: number, itemId: string, domain: DomainType, itemTitle: string) => void;  // Item selected via voice
  onSentenceSync?: (messageId: string, responseId?: string) => void;  // Called when sentenceSync message arrives (text will come with audio)
}

interface UseWebSocketReturn {
  isConnected: boolean;
  status: ConversationStatus;
  emotion: EmotionType;
  statusText: string;
  messages: ChatMessage[];
  error: string | null;
  lastTiming: TimingInfo | null;
  workflowTiming: WorkflowTiming | null;
  userId: string | null;
  historyLoaded: boolean;
  sendMessage: (text: string) => void;
  sendAudioData: (data: ArrayBuffer) => void;
  startListening: () => void;
  stopListening: () => void;
  requestRandomUser: () => void;
  loadHistory: (userId: string, limit?: number) => void;
  requestGreeting: () => void;
  saveToArchive: (userId: string, domain: DomainType, itemId: string, itemTitle?: string, itemData?: Record<string, unknown>) => void;
  // New method using unified message format
  sendVoiceEvent: (event: VoiceEventMessage) => void;
  // Send item selection (card tap or voice number)
  sendSelectItem: (index: number, itemId: string, action: "focus" | "detail" | "save") => void;
  // Expose WebSocket ref for direct access (used by Google STT hook)
  wsRef: React.RefObject<WebSocket | null>;
  // Append sentence text to a message (for sentence-sync audio display)
  appendToMessage: (messageId: string, sentence: string) => void;
}

export function useWebSocket({
  url,
  onAudio,
  onAudioChunk,
  onWaiting,
  onTranscript,
  onBackendResponse,
  onItemFocused,
  onSentenceSync,
}: UseWebSocketOptions): UseWebSocketReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [status, setStatus] = useState<ConversationStatus>("idle");
  const [emotion, setEmotion] = useState<EmotionType>("neutral");
  const [statusText, setStatusText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastTiming, setLastTiming] = useState<TimingInfo | null>(null);
  const [workflowTiming, setWorkflowTiming] = useState<WorkflowTiming | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const messageIdRef = useRef(0);
  
  // Timing refs for measuring actual perceived latency
  const requestStartTimeRef = useRef<number | null>(null);
  const firstResponseTimeRef = useRef<number | null>(null);
  const firstAudioTimeRef = useRef<number | null>(null);

  // Generate unique message ID
  const generateId = useCallback(() => {
    messageIdRef.current += 1;
    return `msg-${messageIdRef.current}-${Date.now()}`;
  }, []);

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    log.debug("Connecting to WebSocket:", url);
    const ws = new WebSocket(url);

    ws.onopen = () => {
      log.debug("WebSocket connected");
      setIsConnected(true);
      setError(null);
    };

    ws.onclose = () => {
      log.debug("WebSocket disconnected");
      setIsConnected(false);
      wsRef.current = null;

      // Attempt to reconnect after 3 seconds
      reconnectTimeoutRef.current = setTimeout(() => {
        log.debug("Attempting to reconnect...");
        connect();
      }, 3000);
    };

    ws.onerror = (event) => {
      log.error("WebSocket error:", event);
      setError("Connection error occurred");
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as WSMessage;
        handleMessage(message);
      } catch (err) {
        log.error("Failed to parse message:", err);
      }
    };

    wsRef.current = ws;
  }, [url]);

  // Handle incoming messages
  const handleMessage = useCallback(
    (message: WSMessage) => {
      switch (message.type) {
        case "connected":
          log.debug("Connected:", message.message);
          break;

        case "status":
          setStatus(message.status as ConversationStatus);
          setEmotion(message.emotion as EmotionType);
          setStatusText(message.statusText as string);
          break;

        case "user_message":
          setMessages((prev) => [
            ...prev,
            {
              id: generateId(),
              role: "user",
              content: message.text as string,
              timestamp: new Date(),
              domain: message.domain as DomainType | undefined,
            },
          ]);
          break;

        case "assistant_message": {
          const messageId = message.messageId as string | undefined;
          const archiveItem = message.archiveItem as any;
          const searchResults = message.searchResults as any;
          const sentenceSync = message.sentenceSync as boolean | undefined;
          
          // When sentenceSync is true, text will be revealed sentence-by-sentence
          // as audio chunks start playing. Create message with empty content.
          const displayText = sentenceSync ? "" : (message.text as string);
          
          // Notify parent about sentence sync mode
          if (sentenceSync && messageId) {
            onSentenceSync?.(messageId, message.responseId as string | undefined);
          }
          
          if (messageId) {
            // Update existing message or add new one with messageId
            setMessages((prev) => {
              const index = prev.findIndex((m) => m.id === messageId);
              if (index >= 0) {
                // Update existing message
                const updated = [...prev];
                // If sentenceSync, don't overwrite content that was built up by sentences
                const content = sentenceSync 
                  ? (updated[index].content || "")  // Keep accumulated sentence text
                  : (message.text as string);
                updated[index] = {
                  ...updated[index],
                  content,
                  emotion: message.emotion as EmotionType,
                  domain: message.domain as DomainType | undefined,
                  messageId,
                  archiveItem,
                  searchResults,
                };
                return updated;
              }
              // Add new message with messageId
              return [
                ...prev,
                {
                  id: messageId,
                  role: "assistant",
                  content: displayText,
                  emotion: message.emotion as EmotionType,
                  timestamp: new Date(),
                  domain: message.domain as DomainType | undefined,
                  messageId,
                  archiveItem,
                  searchResults,
                },
              ];
            });
          } else {
            // Add new message without messageId (generate one)
            setMessages((prev) => [
              ...prev,
              {
                id: generateId(),
                role: "assistant",
                content: displayText,
                emotion: message.emotion as EmotionType,
                timestamp: new Date(),
                domain: message.domain as DomainType | undefined,
                archiveItem,
                searchResults,
              },
            ]);
          }
          break;
        }

        case "assistant_delta": {
          const messageId = message.messageId as string;
          const delta = message.text as string;
          if (!messageId || !delta) break;

          // Record time to first response (first text delta)
          if (requestStartTimeRef.current && !firstResponseTimeRef.current) {
            firstResponseTimeRef.current = performance.now();
            const ttfr = Math.round(firstResponseTimeRef.current - requestStartTimeRef.current);
            log.debug(`⚡ Time to First Response: ${ttfr}ms`);
            // Notify that backend responded (cancel waiting timer)
            onBackendResponse?.();
          }

          setMessages((prev) => {
            const index = prev.findIndex((m) => m.id === messageId);
            if (index >= 0) {
              const updated = [...prev];
              updated[index] = {
                ...updated[index],
                content: `${updated[index].content}${delta}`,
              };
              return updated;
            }
            return [
              ...prev,
              {
                id: messageId,
                role: "assistant",
                content: delta,
                timestamp: new Date(),
              },
            ];
          });
          break;
        }

        case "audio":
          // Record time to first audio
          if (requestStartTimeRef.current && !firstAudioTimeRef.current) {
            firstAudioTimeRef.current = performance.now();
            const ttfa = Math.round(firstAudioTimeRef.current - requestStartTimeRef.current);
            log.debug(`🔊 Time to First Audio: ${ttfa}ms`);
          }
          // Log audio arrival with responseId
          const audioResponseId = message.responseId as string | undefined;
          log.debug(`📨 Received full audio message (responseId: ${audioResponseId ? audioResponseId.slice(-8) : 'none'})`);
          // Pass audio with responseId for validation
          onAudio?.(message.data as string, message.format as string, audioResponseId);
          break;

        case "audio_chunk":
          // Record time to first audio chunk
          if (requestStartTimeRef.current && !firstAudioTimeRef.current) {
            firstAudioTimeRef.current = performance.now();
            const ttfa = Math.round(firstAudioTimeRef.current - requestStartTimeRef.current);
            log.debug(`🔊 Time to First Audio Chunk: ${ttfa}ms`);
            // Notify that backend responded (cancel waiting timer if not already cancelled)
            onBackendResponse?.();
          }
          onAudioChunk?.({
            data: message.data as string,
            format: message.format as string,
            index: message.index as number,
            total: message.total as number,
            isLast: message.isLast as boolean,
            responseId: message.responseId as string | undefined,
            sentence: message.sentence as string | undefined,
          });
          break;

        case "waiting":
          // Play pre-recorded waiting audio before DB search (DEPRECATED)
          log.debug(`⏳ Waiting signal received: #${message.index}`);
          onWaiting?.(message.index as number);
          break;

        case "long_waiting":
          // Server-streamed long waiting audio (for database queries)
          const longWaitingResponseId = message.responseId as string | undefined;
          log.debug(`⏳ Long waiting received: "${message.text}" (responseId: ${longWaitingResponseId ? longWaitingResponseId.slice(-8) : 'none'})`);
          // Record time to first audio (this counts as audio response)
          if (requestStartTimeRef.current && !firstAudioTimeRef.current) {
            firstAudioTimeRef.current = performance.now();
            const ttfa = Math.round(firstAudioTimeRef.current - requestStartTimeRef.current);
            log.debug(`🔊 Time to Long Waiting Audio: ${ttfa}ms`);
            // Notify that backend responded
            onBackendResponse?.();
          }
          // Play the long waiting audio immediately with responseId and PROTECTED flag
          onAudio?.(message.audio as string, "mp3", longWaitingResponseId, true);
          break;

        case "transcript":
          // Real-time transcription from AWS Transcribe
          onTranscript?.(
            message.text as string,
            message.isFinal as boolean
          );
          break;

        case "processing_voice":
          // Backend started processing voice input - start TTFR timer
          log.debug("🎤 Voice processing started, starting TTFR timer");
          requestStartTimeRef.current = performance.now();
          firstResponseTimeRef.current = null;
          firstAudioTimeRef.current = null;
          break;

        case "error":
          setError(message.message as string);
          break;

        case "timing":
          setLastTiming({
            timings: message.timings as Array<{ action: string; durationMs: number }>,
            totalMs: message.totalMs as number,
          });
          break;

        case "workflow_timing": {
          // Calculate frontend-measured timings
          const timeToFirstResponse = (requestStartTimeRef.current && firstResponseTimeRef.current)
            ? Math.round(firstResponseTimeRef.current - requestStartTimeRef.current)
            : undefined;
          const timeToFirstAudio = (requestStartTimeRef.current && firstAudioTimeRef.current)
            ? Math.round(firstAudioTimeRef.current - requestStartTimeRef.current)
            : undefined;
          
          setWorkflowTiming({
            steps: message.steps as WorkflowStep[],
            hasDbSearch: message.hasDbSearch as boolean,
            dbSearchTime: message.dbSearchTime as number,
            usedTool: message.usedTool as boolean,
            totalMs: message.totalMs as number,
            timeToFirstResponse,
            timeToFirstAudio,
          });
          // Also set legacy timing for backwards compatibility
          setLastTiming({
            timings: (message.steps as WorkflowStep[]).map((s) => ({
              action: s.nameJa,
              durationMs: s.durationMs,
            })),
            totalMs: message.totalMs as number,
          });
          
          // Reset timing refs for next request
          requestStartTimeRef.current = null;
          firstResponseTimeRef.current = null;
          firstAudioTimeRef.current = null;
          break;
        }

        case "archive_saved":
          log.debug(`✅ Archive saved: ${message.domain}/${message.itemId}`);
          // Update archiveStorage (single source of truth)
          // Components using useArchiveStorage hook will auto re-render
          if (message.friends_matched && Array.isArray(message.friends_matched)) {
            archiveStorage.updateItem(
              message.itemId as string,
              message.domain as DomainType,
              {
                savedAt: new Date(),
                friendsMatched: message.friends_matched as FriendMatch[],
              }
            );
            log.debug(`👥 Friends matched: ${(message.friends_matched as FriendMatch[]).length}`);
          }
          break;

        case "user_info_set":
          if (message.success && message.user) {
            const user = message.user as { userId: number; nickName: string };
            setUserId(user.userId.toString());
            log.debug(`👤 User set: ${user.nickName} (ID: ${user.userId})`);
          }
          break;

        case "history_loaded": {
          const historyMsg = message as any;
          if (historyMsg.history && Array.isArray(historyMsg.history)) {
            log.info(`📜 Loaded ${historyMsg.history.length} history items`);
            
            // Convert history to chat messages (silently, no audio)
            const historyMessages: ChatMessage[] = historyMsg.history.map((turn: any, index: number) => ({
              id: `history-${index}-${Date.now()}`,
              role: turn.role,
              content: turn.content,
              emotion: turn.emotion,
              timestamp: new Date(),
              domain: turn.domain,
            }));
            
            setMessages(historyMessages);
            setHistoryLoaded(true);
            log.debug("✅ History loaded and displayed");
          }
          break;
        }

        case "item_focused": {
          // Backend tells us an item was selected (via voice number)
          const focusedIndex = message.index as number;
          const focusedItemId = message.itemId as string;
          const focusedDomain = message.domain as DomainType;
          const focusedTitle = message.itemTitle as string;
          log.debug(`🔢 Item focused: ${focusedIndex + 1}番 "${focusedTitle}" (${focusedDomain})`);
          onItemFocused?.(focusedIndex, focusedItemId, focusedDomain, focusedTitle);
          break;
        }

        case "pong":
          // Heartbeat response
          break;

        // ================================================================
        // New message types from shared package
        // These are the improved communication patterns
        // ================================================================
        
        case "response": {
          // New unified response message
          const responseMsg = message as unknown as ResponseMessage;
          const { rabbit, text, component, context, extra } = responseMsg;
          
          // Update rabbit state
          if (rabbit) {
            setStatus(rabbit.status);
            setEmotion(rabbit.emotion);
          }
          
          // Handle text content
          if (text) {
            if (text.isStreaming) {
              // Streaming delta - update existing message
              if (requestStartTimeRef.current && !firstResponseTimeRef.current) {
                firstResponseTimeRef.current = performance.now();
                const ttfr = Math.round(firstResponseTimeRef.current - requestStartTimeRef.current);
                log.debug(`⚡ Time to First Response (new format): ${ttfr}ms`);
                onBackendResponse?.();
              }
              
              setMessages((prev) => {
                const index = prev.findIndex((m) => m.id === text.messageId);
                if (index >= 0) {
                  const updated = [...prev];
                  updated[index] = {
                    ...updated[index],
                    content: `${updated[index].content}${text.content}`,
                  };
                  return updated;
                }
                return [
                  ...prev,
                  {
                    id: text.messageId,
                    role: "assistant",
                    content: text.content,
                    emotion: rabbit?.emotion,
                    timestamp: new Date(),
                    domain: context?.domain,
                  },
                ];
              });
            } else {
              // Complete message
              setMessages((prev) => {
                const index = prev.findIndex((m) => m.id === text.messageId);
                
                // Build search results from component data
                let searchResults = undefined;
                if (component?.type === "movie_list" && component.data) {
                  const data = component.data as { movies: any[]; total: number };
                  searchResults = { type: "movie" as const, movies: data.movies, total: data.total };
                } else if (component?.type === "gourmet_list" && component.data) {
                  const data = component.data as { restaurants: any[]; total: number };
                  searchResults = { type: "gourmet" as const, restaurants: data.restaurants, total: data.total };
                }
                
                if (index >= 0) {
                  const updated = [...prev];
                  updated[index] = {
                    ...updated[index],
                    content: text.content,
                    emotion: rabbit?.emotion,
                    domain: context?.domain,
                    archiveItem: extra?.archiveItem,
                    searchResults,
                  };
                  return updated;
                }
                return [
                  ...prev,
                  {
                    id: text.messageId,
                    role: "assistant",
                    content: text.content,
                    emotion: rabbit?.emotion,
                    timestamp: new Date(),
                    domain: context?.domain,
                    messageId: text.messageId,
                    archiveItem: extra?.archiveItem,
                    searchResults,
                  },
                ];
              });
            }
          }
          break;
        }
        
        case "audio": {
          // New unified audio message (not legacy "audio")
          // Check if it's the new format by looking for nested audio object
          const audioMsg = message as unknown as AudioMessage;
          if (audioMsg.audio && typeof audioMsg.audio === "object") {
            const { audio, text: audioText, responseId } = audioMsg;
            
            // Record time to first audio
            if (requestStartTimeRef.current && !firstAudioTimeRef.current) {
              firstAudioTimeRef.current = performance.now();
              const ttfa = Math.round(firstAudioTimeRef.current - requestStartTimeRef.current);
              log.debug(`🔊 Time to First Audio (new format): ${ttfa}ms`);
              onBackendResponse?.();
            }
            
            if (audio.isChunked && audio.chunk) {
              // Chunked audio
              onAudioChunk?.({
                data: audio.data,
                format: audio.format,
                index: audio.chunk.index,
                total: audio.chunk.total,
                isLast: audio.chunk.isLast,
                responseId,
              });
            } else {
              // Full audio (protected or not)
              onAudio?.(audio.data, audio.format, responseId, audio.isProtected);
            }
          } else {
            // Legacy audio format - handle as before
            if (requestStartTimeRef.current && !firstAudioTimeRef.current) {
              firstAudioTimeRef.current = performance.now();
              const ttfa = Math.round(firstAudioTimeRef.current - requestStartTimeRef.current);
              log.debug(`🔊 Time to First Audio: ${ttfa}ms`);
            }
            const audioResponseId = message.responseId as string | undefined;
            log.debug(`📨 Received full audio message (responseId: ${audioResponseId ? audioResponseId.slice(-8) : 'none'})`);
            onAudio?.(message.data as string, message.format as string, audioResponseId);
          }
          break;
        }
        
        case "error": {
          // Check if it's the new format
          const errorMsg = message as unknown as ErrorMessage;
          if (errorMsg.error && typeof errorMsg.error === "object") {
            // New error format
            setError(errorMsg.error.message);
            log.error(`Error [${errorMsg.error.code}]: ${errorMsg.error.message} (recoverable: ${errorMsg.error.recoverable})`);
          } else {
            // Legacy error format
            setError(message.message as string);
          }
          break;
        }

        // Google STT messages are handled by useGoogleSTT hook directly
        // Just ignore them here to avoid "Unknown message" warnings
        case "stt_transcript":
        case "stt_started":
        case "stt_stopped":
        case "stt_error":
          break;

        default:
          log.debug("Unknown message type:", message.type);
      }
    },
    [generateId, onAudio, onAudioChunk, onWaiting, onTranscript, onBackendResponse, onItemFocused, onSentenceSync]
  );

  // Send message to server
  const sendMessage = useCallback((text: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      // Start timing for TTFR measurement
      requestStartTimeRef.current = performance.now();
      firstResponseTimeRef.current = null;
      firstAudioTimeRef.current = null;
      
      wsRef.current.send(
        JSON.stringify({
          type: "text_input",
          text,
        })
      );
    }
  }, []);

  // Send audio data (for voice input)
  const sendAudioData = useCallback((data: ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      // Convert ArrayBuffer to base64
      const uint8Array = new Uint8Array(data);
      let binary = "";
      for (let i = 0; i < uint8Array.length; i++) {
        binary += String.fromCharCode(uint8Array[i]);
      }
      const base64 = btoa(binary);
      
      wsRef.current.send(
        JSON.stringify({
          type: "audio_data",
          data: base64,
        })
      );
    }
  }, []);

  // Start listening (for voice input)
  const startListening = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "start_listening" }));
    }
  }, []);

  // Stop listening
  const stopListening = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop_listening" }));
    }
  }, []);

  // Request random user from backend
  const requestRandomUser = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      log.debug("🎲 Requesting random user from backend");
      wsRef.current.send(
        JSON.stringify({
          type: "set_user_info",
        })
      );
    } else {
      log.warn("⚠️ Cannot request user: WebSocket not connected");
    }
  }, []);

  // Load conversation history for user
  const loadHistory = useCallback((userId: string, limit: number = 5) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      log.debug(`📜 Requesting ${limit} history items for user ${userId}`);
      wsRef.current.send(
        JSON.stringify({
          type: "load_history",
          userId,
          limit,
        })
      );
    } else {
      log.warn("⚠️ Cannot load history: WebSocket not connected");
    }
  }, []);

  // Request greeting from backend
  const requestGreeting = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      log.debug("👋 Requesting greeting from backend");
      wsRef.current.send(
        JSON.stringify({
          type: "request_greeting",
        })
      );
    } else {
      log.warn("⚠️ Cannot request greeting: WebSocket not connected");
    }
  }, []);

  // Save to archive
  const saveToArchive = useCallback((
    userId: string,
    domain: DomainType,
    itemId: string,
    itemTitle?: string,
    itemData?: Record<string, unknown>
  ) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      log.debug(`📚 Saving to archive: ${domain}/${itemId}`);
      const message: SaveArchiveMessage = {
        type: "save_archive",
        userId,
        domain,
        itemId,
        itemTitle,
        itemData,
      };
      wsRef.current.send(JSON.stringify(message));
    } else {
      log.warn("⚠️ Cannot save to archive: WebSocket not connected");
    }
  }, []);

  // Send voice event using the new unified message format
  const sendVoiceEvent = useCallback((event: VoiceEventMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      log.debug(`📤 Sending voice_event: ${event.event.name}`);
      wsRef.current.send(JSON.stringify(event));
    } else {
      log.warn("⚠️ Cannot send voice event: WebSocket not connected");
    }
  }, []);

  // Send item selection (card tap or programmatic selection)
  const sendSelectItem = useCallback((
    index: number,
    itemId: string,
    action: "focus" | "detail" | "save"
  ) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      log.debug(`👆 Sending select_item: index=${index}, itemId=${itemId}, action=${action}`);
      wsRef.current.send(JSON.stringify({
        type: "select_item",
        index,
        itemId,
        action,
      }));
    } else {
      log.warn("⚠️ Cannot send select_item: WebSocket not connected");
    }
  }, []);

  // Connect on mount
  useEffect(() => {
    connect();

    // Cleanup on unmount
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  // Reconnect when app returns to foreground (iOS PWA)
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          log.debug("App foregrounded — reconnecting WebSocket");
          // Clear any pending reconnect timer
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
          }
          connect();
        }
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [connect]);

  // Heartbeat to keep connection alive
  useEffect(() => {
    const interval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "ping" }));
      }
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  // Append sentence text to an existing message (for sentence-sync audio display)
  const appendToMessage = useCallback((messageId: string, sentence: string) => {
    setMessages((prev) => {
      const index = prev.findIndex((m) => m.id === messageId);
      if (index < 0) return prev;
      const updated = [...prev];
      updated[index] = {
        ...updated[index],
        content: updated[index].content + sentence,
      };
      return updated;
    });
  }, []);

  return {
    isConnected,
    status,
    emotion,
    statusText,
    messages,
    error,
    lastTiming,
    workflowTiming,
    userId,
    historyLoaded,
    sendMessage,
    sendAudioData,
    startListening,
    stopListening,
    requestRandomUser,
    loadHistory,
    requestGreeting,
    saveToArchive,
    sendVoiceEvent,
    sendSelectItem,
    wsRef,
    appendToMessage,
  };
}
