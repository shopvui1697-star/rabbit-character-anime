"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useAudioPlayer } from "@/hooks/useAudioPlayer";
import { useGoogleSTT } from "@/hooks/useGoogleSTT";
import { useWaitingPhrase } from "@/hooks/useWaitingPhrase";
import { RabbitAvatar, ChatHistory, ChatInput, WorkflowTimingDisplay, SearchResultsPanel } from "@/components";
import { createLogger } from "@/utils/logger";
import { unlockAudio, preloadWaitingSounds, setupVisibilityHandler, duckSharedVolume, restoreSharedVolume } from "@/utils/audioUnlock";
import { shouldPlayWaitingPhrase } from "@/utils/keywordDetection";
import { detectCommand } from "@/utils/voiceCommands";
import { executeCommand, type CommandContext } from "@/utils/commandExecutor";
import archiveStorage from "@/utils/archiveStorage";
import { toHiragana, preloadConverter } from "@/utils/hiraganaConverter";
import {
  checkBargeIn,
  clearTtsContent,
  notifyTtsPlaybackStarted,
  registerTtsContent,
} from "@/utils/bargeInGuard";
import type { ConversationStatus, DomainType, ArchiveItemInfo, SearchResults } from "@/types";
import styles from "./page.module.css";

const log = createLogger("Page");

// WebSocket URL - connect to backend
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001/ws";

// Google STT Configuration
// Audio is streamed via backend WebSocket to Google Cloud Speech-to-Text
// English (en-US) speech recognition
const GOOGLE_STT_CONFIG = {
  languageCode: "en-US",
  sampleRate: 16000,
};

// Minimum characters required for final barge-in submission
const BARGE_IN_MIN_CHARS = parseInt(process.env.NEXT_PUBLIC_BARGE_IN_MIN_CHARS || "5", 10);

// Minimum characters for early barge-in detection (using partial transcripts)
const EARLY_BARGE_IN_MIN_CHARS = parseInt(process.env.NEXT_PUBLIC_EARLY_BARGE_IN_MIN_CHARS || "2", 10);

// Duck TTS volume while mic is active during AI speech (0.0–1.0, default 0.25)
const TTS_DUCK_VOLUME = parseFloat(process.env.NEXT_PUBLIC_TTS_DUCK_VOLUME || "0.25");

// Deeper duck once fast VAD confirms real voice activity (vs the ambient duck above)
const TTS_VAD_DUCK_VOLUME = parseFloat(process.env.NEXT_PUBLIC_TTS_VAD_DUCK_VOLUME || "0.08");

export default function Home() {
  // Unlock AudioContext on first user gesture (required for iOS Safari)
  // and preload waiting sounds into AudioBuffer cache
  useEffect(() => {
    const unlock = () => {
      unlockAudio().then(() => preloadWaitingSounds(20));
      document.removeEventListener("touchstart", unlock);
      document.removeEventListener("click", unlock);
    };
    document.addEventListener("touchstart", unlock, { once: true });
    document.addEventListener("click", unlock, { once: true });
    return () => {
      document.removeEventListener("touchstart", unlock);
      document.removeEventListener("click", unlock);
    };
  }, []);

  // Resume AudioContext when returning from background (iOS PWA)
  useEffect(() => {
    return setupVisibilityHandler();
  }, []);

  // Register service worker for PWA
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Service worker registration failed — non-critical
      });
    }
  }, []);

  // Pre-load Kuroshiro converter for hiragana normalization
  // This loads the kuromoji dictionary (~17MB) in the background
  useEffect(() => {
    preloadConverter().then((success) => {
      if (success) {
        log.info("✅ Hiragana converter pre-loaded");
      } else {
        log.warn("⚠️ Hiragana converter failed to pre-load");
      }
    });
  }, []);

  // Map of in-flight turns: backend responseId -> frontend message bubble ID.
  // Audio chunks carry the responseId they belong to, so this lets onSentencePlay route
  // each sentence to the correct bubble even if turns overlap (barge-in, mic always-on).
  // A single global "current" ref isn't safe here: it can still point at an older turn
  // while that turn's trailing chunks are draining, causing new-turn text to merge in.
  const responseIdToMessageIdRef = useRef<Map<string, string>>(new Map());
  // Ref-based bridge to call appendToMessage from useAudioPlayer callback
  const appendToMessageRef = useRef<((messageId: string, sentence: string) => void) | null>(null);
  // Track if early barge-in was triggered (reset on final transcript)
  const earlyBargeInTriggeredRef = useRef(false);
  // Latest assistant text for echo matching on non-sentence-sync audio
  const lastAssistantTextRef = useRef("");

  const audioPlayer = useAudioPlayer({
    onPlaybackStart: () => {
      notifyTtsPlaybackStarted();
      if (lastAssistantTextRef.current) {
        registerTtsContent(lastAssistantTextRef.current);
      }
    },
    onSentencePlay: (sentence, index, responseId) => {
      registerTtsContent(sentence);
      // When audio chunk N starts playing, display its sentence text — routed by the
      // chunk's own responseId so a lingering previous turn can't write into it.
      const messageId = responseId ? responseIdToMessageIdRef.current.get(responseId) : undefined;
      if (messageId && appendToMessageRef.current) {
        log.debug(`Sentence sync: displaying sentence #${index} for message ${messageId.slice(-8)}`);
        appendToMessageRef.current(messageId, sentence);
      } else {
        log.warn(`Sentence sync: no message mapped for responseId ${responseId?.slice(-8) || "none"}, dropping sentence #${index}`);
      }
    },
  });
  const [voiceDetected, setVoiceDetected] = useState(false);
  // Fast VAD signal (duration-guarded RMS) — confirms real voice activity before any STT transcript
  const [voiceActive, setVoiceActive] = useState(false);
  // Acoustic echo coupling strength (0..1) from the NLMS echo canceller — see onEchoCoupling below
  const echoCouplingRef = useRef(0);
  
  // Numbered selection state: which card is currently selected/focused
  const [selectedResultIndex, setSelectedResultIndex] = useState<number | null>(null);

  // Queue for audio that arrives while short-waiting is still playing
  const pendingAudioQueueRef = useRef<Array<
    | { type: 'full'; audioData: string; format: string; responseId?: string; isProtected?: boolean }
    | { type: 'chunk'; data: string; format: string; index: number; total: number; isLast: boolean; responseId?: string; sentence?: string }
  >>([]);

  // Flush pending audio queue — called when short-waiting finishes + delay
  const flushPendingAudio = useCallback(() => {
    const queue = pendingAudioQueueRef.current;
    if (queue.length === 0) return;

    log.debug(`✅ Flushing ${queue.length} pending audio items`);
    pendingAudioQueueRef.current = [];

    for (const item of queue) {
      if (item.type === 'full') {
        audioPlayer.play(item.audioData, item.format, item.responseId, item.isProtected);
      } else {
        audioPlayer.playChunk(item);
      }
    }
  }, [audioPlayer]);

  // Waiting phrase system (short waiting sounds)
  const waitingPhrase = useWaitingPhrase({
    onWaitingComplete: () => {
      log.debug("⏳ Short-waiting complete + delay finished, backend audio can play now");
      flushPendingAudio();
    },
    onWaitingStart: () => {
      log.debug("⏳ Short-waiting started");
    },
  });

  // Handle full audio from WebSocket (greeting, long_waiting, sequential TTS)
  const handleAudio = useCallback(
    (audioData: string, format: string, responseId?: string, isProtected?: boolean) => {
      log.debug(`🔊 Received full audio (responseId: ${responseId?.slice(-8) || "none"}, protected: ${isProtected || false})`);

      // If short-waiting is playing (or in post-delay), queue this audio
      if (waitingPhrase.isWaitingPhrasePlaying()) {
        log.debug("⏳ Short-waiting active - queueing backend audio");
        pendingAudioQueueRef.current.push({ type: 'full', audioData, format, responseId, isProtected });
        return;
      }

      audioPlayer.play(audioData, format, responseId, isProtected);
    },
    [audioPlayer, waitingPhrase]
  );

  // Handle audio chunks for parallel TTS streaming
  const handleAudioChunk = useCallback(
    (chunk: { data: string; format: string; index: number; total: number; isLast: boolean; responseId?: string; sentence?: string }) => {
      // If short-waiting is playing (or in post-delay), queue ALL chunks
      if (waitingPhrase.isWaitingPhrasePlaying()) {
        log.debug(`⏳ Short-waiting active - queueing chunk ${chunk.index}/${chunk.total}`);
        pendingAudioQueueRef.current.push({ type: 'chunk', ...chunk });
        return;
      }

      if (chunk.sentence) {
        registerTtsContent(chunk.sentence);
      }
      audioPlayer.playChunk(chunk);
    },
    [audioPlayer, waitingPhrase]
  );

  // Handle item focused from backend (voice number selection "2番")
  const handleItemFocused = useCallback((index: number, itemId: string, domain: DomainType, itemTitle: string) => {
    log.info(`🔢 Item focused from voice: ${index + 1}番 "${itemTitle}"`);
    setSelectedResultIndex(index);
  }, []);

  const {
    isConnected,
    status: wsStatus,
    emotion,
    statusText,
    messages,
    error,
    workflowTiming,
    userId,
    historyLoaded,
    sendMessage: wsSendMessage,
    requestRandomUser,
    loadHistory,
    requestGreeting,
    saveToArchive,
    sendSelectItem,
    wsRef,
    appendToMessage,
  } = useWebSocket({
    url: WS_URL,
    onAudio: handleAudio,
    onAudioChunk: handleAudioChunk,
    onBackendResponse: () => {
      // Backend responded - cancel waiting timer if still waiting
      waitingPhrase.cancelWaitingTimer();
    },
    onItemFocused: handleItemFocused,
    onSentenceSync: (messageId, responseId) => {
      // Sentence-sync mode: text will be revealed sentence-by-sentence with audio
      log.debug(`Sentence sync mode for message: ${messageId.slice(-8)} (responseId: ${responseId?.slice(-8) || "none"})`);
      if (responseId) {
        responseIdToMessageIdRef.current.set(responseId, messageId);
        // Bound the map: drop the oldest entry once it grows past a small cap so a
        // long-running session doesn't accumulate one entry per turn forever.
        if (responseIdToMessageIdRef.current.size > 10) {
          const oldestKey = responseIdToMessageIdRef.current.keys().next().value;
          if (oldestKey) responseIdToMessageIdRef.current.delete(oldestKey);
        }
      }
    },
  });

  // Keep appendToMessage ref updated for the audioPlayer callback
  appendToMessageRef.current = appendToMessage;

  // Save to archive - archiveStorage handles state, ChatHistory uses useArchiveStorage hook
  const handleSaveToArchive = useCallback((
    userId: string,
    domain: DomainType,
    itemId: string,
    itemTitle?: string,
    itemData?: Record<string, unknown>
  ) => {
    // Call WebSocket save - backend will respond with archive_saved
    // useWebSocket will update archiveStorage, which triggers re-render via useArchiveStorage hook
    saveToArchive(userId, domain, itemId, itemTitle, itemData);

    // Optimistically mark as saved in archiveStorage (immediate UI feedback)
    // Include itemTitle and itemData so the item can be created if it doesn't exist
    archiveStorage.updateItem(itemId, domain, { 
      savedAt: new Date(),
      itemTitle,
      itemDomain: domain,
      itemData,
    });
    log.debug(`✅ Optimistic save: ${itemId}`);
  }, [saveToArchive]);

  // Reset selected index when new search results arrive
  const latestSearchResultRef = useRef<SearchResults | undefined>(undefined);
  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === "assistant" && lastMsg.searchResults) {
      if (lastMsg.searchResults !== latestSearchResultRef.current) {
        latestSearchResultRef.current = lastMsg.searchResults;
        setSelectedResultIndex(null);
        log.debug("🔄 New search results arrived, reset selection");
      }
    }
  }, [messages]);

  // Handle card selection from touch (tap on card)
  const handleCardSelect = useCallback((index: number, itemId: string, action: "focus" | "detail" | "save") => {
    log.info(`👆 Card selected: ${index + 1}番, action=${action}`);
    setSelectedResultIndex(index);
    
    // Send to backend so LLM knows the selection
    sendSelectItem(index, itemId, action);
    
    // If action is "save", also trigger archive save
    if (action === "save" && userId) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.searchResults) {
        const { searchResults } = lastMsg;
        if (searchResults.type === "movie" && searchResults.movies?.[index]) {
          const movie = searchResults.movies[index];
          const movieItemId = movie.id?.toString() || itemId;
          handleSaveToArchive(userId, "movie", movieItemId, movie.title_ja, {
            title_en: movie.title_en,
            description: movie.description,
            release_year: movie.release_year,
            rating: movie.rating,
            director: movie.director,
            actors: movie.actors,
          });
        } else if (searchResults.type === "gourmet" && searchResults.restaurants?.[index]) {
          const restaurant = searchResults.restaurants[index];
          const restaurantItemId = restaurant.id?.toString() || itemId;
          handleSaveToArchive(userId, "gourmet", restaurantItemId, restaurant.name, {
            code: restaurant.code,
            address: restaurant.address,
            catch_copy: restaurant.catch_copy,
            urls_pc: restaurant.urls_pc,
            open_hours: restaurant.open_hours,
          });
        }
      }
    }
  }, [sendSelectItem, userId, messages, handleSaveToArchive]);

  // Push archivable items to storage when they arrive
  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === "assistant") {
      try {
        // Push single archiveItem (for backward compatibility)
        if (lastMessage.archiveItem) {
          archiveStorage.push(lastMessage.archiveItem);
          log.debug(`📥 Pushed single item to archive storage: ${lastMessage.archiveItem.itemTitle}`);
        }
        
        // Push all items from searchResults (batch operation for multiple results)
        if (lastMessage.searchResults) {
          const { searchResults } = lastMessage;
          const itemsToPush: ArchiveItemInfo[] = [];
          
          if (searchResults.type === "movie" && searchResults.movies) {
            searchResults.movies.forEach((movie) => {
              itemsToPush.push({
                itemId: movie.id?.toString() || `movie-${Date.now()}-${Math.random()}`,
                itemTitle: movie.title_ja,
                itemDomain: "movie",
                itemData: {
                  title_en: movie.title_en,
                  description: movie.description,
                  release_year: movie.release_year,
                  rating: movie.rating,
                  director: movie.director,
                  actors: movie.actors,
                },
              });
            });
          }
          
          if (searchResults.type === "gourmet" && searchResults.restaurants) {
            searchResults.restaurants.forEach((restaurant) => {
              itemsToPush.push({
                itemId: restaurant.id?.toString() || `gourmet-${Date.now()}-${Math.random()}`,
                itemTitle: restaurant.name,
                itemDomain: "gourmet",
                itemData: {
                  code: restaurant.code,
                  address: restaurant.address,
                  catch_copy: restaurant.catch_copy,
                  urls_pc: restaurant.urls_pc,
                  open_hours: restaurant.open_hours,
                  close_days: restaurant.close_days,
                  access: restaurant.access,
                },
              });
            });
          }
          
          // Batch push all items at once (more efficient)
          if (itemsToPush.length > 0) {
            archiveStorage.pushMany(itemsToPush);
            log.debug(`📥 Batch pushed ${itemsToPush.length} ${searchResults.type} items to archive storage`);
          }
        }
      } catch (error) {
        log.error("Failed to push to archive storage:", error);
      }
    }
  }, [messages]);

  // Auto-fetch random user when WebSocket connects, then load history
  useEffect(() => {
    if (isConnected && requestRandomUser) {
      log.info("🔐 WebSocket connected - requesting random user...");
      setTimeout(() => {
        requestRandomUser();
        log.info('📨 Random user request sent');
      }, 100);
    }
  }, [isConnected, requestRandomUser]);

  // Load history after user is set, then request greeting
  useEffect(() => {
    if (userId && !historyLoaded) {
      log.info(`📜 User set (${userId}) - loading history...`);
      setTimeout(() => {
        loadHistory(userId, 5); // Load 5 most recent items
        log.info('📨 History load request sent');
      }, 200);
    }
  }, [userId, historyLoaded, loadHistory]);

  // Request greeting after history is loaded
  useEffect(() => {
    if (historyLoaded) {
      log.info("✅ History loaded - requesting greeting...");
      setTimeout(() => {
        requestGreeting();
        log.info('👋 Greeting request sent');
      }, 300);
    }
  }, [historyLoaded, requestGreeting]);

  // Send message - cancel all audio and send to backend
  // Only convert to hiragana when movie/gourmet keywords detected (for better search matching)
  // Normal conversation keeps original text for better Claude response quality
  const sendMessage = useCallback(async (text: string) => {
    log.debug(`📤 Sending message: "${text}"`);

    // CRITICAL: Cancel all audio - stops current playback and rejects old audio
    audioPlayer.cancelAllAudio();
    clearTtsContent();
    restoreSharedVolume();

    // Clear any pending audio waiting for short-waiting to finish
    pendingAudioQueueRef.current = [];

    // Stop any waiting phrase
    waitingPhrase.stopWaitingPhrase();

    // 🎯 CHECK FOR COMMANDS FIRST (works for both text and voice input)
    const command = detectCommand(text);
    
    if (command) {
      log.info(`⌨️ Text command detected: ${command.type} (keyword: "${command.keyword}")`);
      
      // Execute command locally with full context (search results, selection, etc.)
      const commandContext: CommandContext = {
        userId,
        saveToArchive: handleSaveToArchive,
        originalText: text,
        messages,
        selectedIndex: selectedResultIndex,
      };
      
      const result = executeCommand(command.type, commandContext);
      
      if (result.success) {
        log.info(`✅ Command executed: ${result.message}`);
      } else {
        log.warn(`❌ Command failed: ${result.message}`);
      }
      
      // Check if we should still send to backend
      if (!result.shouldSendToBackend) {
        log.debug("⏹️ Command handled locally, not sending to backend");
        return; // Don't send to backend
      }
    }

    // No command or command wants to send to backend
    // Check if message contains movie/gourmet keywords
    const hasDbKeywords = shouldPlayWaitingPhrase(text);
    log.debug(`🔍 Keyword detection: ${hasDbKeywords ? "movie/gourmet detected" : "traditional conversation"}`);

    // Start waiting timer only if keywords detected (will play short waiting sound if backend takes > 1s)
    waitingPhrase.startWaitingTimer(hasDbKeywords);

    // Only convert to hiragana if movie/gourmet keywords detected
    // This helps backend match movie/restaurant names regardless of how STT outputs them
    // Normal conversation keeps original text for better Claude response quality
    if (hasDbKeywords) {
      try {
        const hiraganaText = await toHiragana(text);
        log.debug(`📝 Hiragana conversion: "${text}" → "${hiraganaText}"`);
        wsSendMessage(hiraganaText);
      } catch (error) {
        log.warn("⚠️ Hiragana conversion failed, sending original text:", error);
        wsSendMessage(text);
      }
    } else {
      // Normal conversation - send original text
      wsSendMessage(text);
    }
  }, [wsSendMessage, audioPlayer, waitingPhrase, userId, handleSaveToArchive, messages, selectedResultIndex]);

  // Shared early-barge-in trigger — used both by NineRouter's own interim transcript
  // and by the Web Speech assist signal (§9.4.L), whichever fires first "wins".
  // Only ducks/cancels audio; final submission is always driven by NineRouter's onTranscript.
  const tryEarlyBargeIn = useCallback((rawText: string, source: string) => {
    const trimmedText = rawText.trim();
    if (!trimmedText) return;

    const aiSpeaking = audioPlayer.isPlaying || wsStatus === "speaking";
    const bargeInCheck = checkBargeIn({
      text: trimmedText,
      isFinal: false,
      aiSpeaking,
      earlyMinChars: EARLY_BARGE_IN_MIN_CHARS,
    });

    if (!bargeInCheck.allowed) {
      if (bargeInCheck.reason === "echo") {
        log.debug(`🚫 Echo filtered (${source}): "${trimmedText}"`);
      } else if (bargeInCheck.reason === "cooldown") {
        log.debug(`⏳ Barge-in cooldown (${source}): ignoring "${trimmedText}"`);
      }
      return;
    }

    if (
      aiSpeaking &&
      trimmedText.length >= EARLY_BARGE_IN_MIN_CHARS &&
      !earlyBargeInTriggeredRef.current
    ) {
      log.debug(`🟡 EARLY BARGE-IN (${source}): Stopping audio (${trimmedText.length} chars detected)`);
      audioPlayer.cancelAllAudio();
      restoreSharedVolume();
      earlyBargeInTriggeredRef.current = true;
    }
  }, [audioPlayer, wsStatus]);

  // Google STT for voice input (streamed via backend WebSocket)
  // Backend handles Google's 5-minute stream limit transparently — no frontend refresh needed.
  // Mic stays on until user explicitly clicks stop. Barge-in supported via early interim detection.
  const transcribe = useGoogleSTT({
    config: GOOGLE_STT_CONFIG,
    wsRef,
    wsConnected: isConnected,
    stopOnTabHidden: true,
    onTranscript: useCallback((text: string, isFinal: boolean) => {
      log.debug(`📝 Transcript ${isFinal ? "(final)" : "(interim)"}:`, text);

      if (!isFinal) {
        tryEarlyBargeIn(text, "nineRouter");
        return;
      }

      // FINAL: Submit transcript — NineRouter/Groq stays the sole source of truth for this
      const trimmedText = text.trim();
      const aiSpeaking = audioPlayer.isPlaying || wsStatus === "speaking";

      const bargeInCheck = checkBargeIn({
        text: trimmedText,
        isFinal: true,
        aiSpeaking,
        earlyMinChars: EARLY_BARGE_IN_MIN_CHARS,
      });

      if (!bargeInCheck.allowed) {
        if (bargeInCheck.reason === "echo") {
          log.debug(`🚫 Echo filtered: "${trimmedText}"`);
        }
        return;
      }

      earlyBargeInTriggeredRef.current = false;

      if (!trimmedText || trimmedText.length < BARGE_IN_MIN_CHARS) {
        log.debug(`⏭️ Transcript too short (${trimmedText.length} chars), ignoring`);
        return;
      }

      // Regular barge-in if early wasn't triggered
      if (aiSpeaking) {
        log.debug("🔇 REGULAR BARGE-IN: Stopping audio");
        audioPlayer.cancelAllAudio();
        restoreSharedVolume();
      }

      // Send to sendMessage - it will handle command detection and hiragana conversion
      // Mic stays on for continuous conversation (barge-in supported)
      log.debug(`✅ Submitting: "${trimmedText}"`);
      sendMessage(trimmedText).catch((err) => {
        log.error("Failed to send message:", err);
      });
    }, [audioPlayer, wsStatus, sendMessage, tryEarlyBargeIn]),
    onVoiceActivity: useCallback((active: boolean) => {
      setVoiceActive(active);
    }, []),
    // Web Speech assist signal (§9.4.L) — fast, not authoritative. Runs in parallel with
    // NineRouter when supported; only accelerates the early-barge-in duck/cancel above.
    onFastSignal: useCallback((text: string) => {
      tryEarlyBargeIn(text, "webSpeechAssist");
    }, [tryEarlyBargeIn]),
    // Echo coupling strength (0..1) from the NLMS echo canceller — a ref, not state,
    // since it updates ~2x/sec and only needs to be read when the duck effect below
    // actually re-runs (on voiceActive/isPlaying changes), not on every tick itself.
    onEchoCoupling: useCallback((strength: number) => {
      echoCouplingRef.current = strength;
    }, []),
    onError: useCallback((err: Error) => {
      log.error("Google STT error:", err);
    }, []),
  });

  // Keep latest assistant text for echo filter (non-chunked TTS)
  useEffect(() => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant?.content) {
      lastAssistantTextRef.current = lastAssistant.content;
    }
  }, [messages]);

  // Duck TTS volume while mic is active during AI speech — reduces speaker→mic echo.
  // Ambient duck while just listening; deeper duck once VAD confirms real voice activity
  // (duck-then-confirm: the actual cancel/send decision still waits on STT transcript below).
  //
  // Duck depth is blended by echo coupling strength (0..1, from the NLMS echo canceller):
  // strong coupling (e.g. laptop built-in speaker) → duck all the way to the configured
  // level; near-zero coupling (e.g. headphones — nothing to echo) → barely duck at all,
  // since there's no real echo risk to guard against and ducking would only cost
  // responsiveness/naturalness for no benefit.
  useEffect(() => {
    const shouldDuck =
      transcribe.isListening && (audioPlayer.isPlaying || wsStatus === "speaking");

    if (shouldDuck) {
      const coupling = Math.max(0, Math.min(1, echoCouplingRef.current));
      const baseLevel = voiceActive ? TTS_VAD_DUCK_VOLUME : TTS_DUCK_VOLUME;
      const duckTarget = 1 - coupling * (1 - baseLevel); // lerp(1, baseLevel, coupling)
      duckSharedVolume(duckTarget);
    } else {
      restoreSharedVolume();
    }
  }, [transcribe.isListening, audioPlayer.isPlaying, wsStatus, voiceActive]);

  // Visual "listening" indicator — fast VAD signal or interim transcript, whichever comes first
  const checkVoiceActivity = useCallback(() => {
    setVoiceDetected(voiceActive || transcribe.interimTranscript.length > 0);
  }, [voiceActive, transcribe.interimTranscript]);

  React.useEffect(() => {
    checkVoiceActivity();
  }, [checkVoiceActivity]);

  // Compute focused item info for the focus strip in chat section
  const focusedItem = useMemo(() => {
    if (selectedResultIndex === null) return null;
    const lastMsg = [...messages].reverse().find(
      m => m.role === "assistant" && m.searchResults && m.searchResults.total > 0
    );
    if (!lastMsg?.searchResults) return null;
    const { searchResults } = lastMsg;
    if (searchResults.type === "movie" && searchResults.movies) {
      const movie = searchResults.movies[selectedResultIndex];
      if (!movie) return null;
      return { name: movie.title_ja, index: selectedResultIndex, itemId: movie.id?.toString() || `movie-${Date.now()}` };
    }
    if (searchResults.type === "gourmet" && searchResults.restaurants) {
      const restaurant = searchResults.restaurants[selectedResultIndex];
      if (!restaurant) return null;
      return { name: restaurant.name, index: selectedResultIndex, itemId: restaurant.id?.toString() || `gourmet-${Date.now()}` };
    }
    return null;
  }, [selectedResultIndex, messages]);

  // Derive status — only show "speaking" avatar when audio is actually playing
  const status: ConversationStatus = useMemo(() => {
    if (audioPlayer.isPlaying) return "speaking";
    // Backend may send "speaking" before audio starts; keep "thinking" until playback begins
    if (wsStatus === "speaking") return "thinking";
    return wsStatus;
  }, [audioPlayer.isPlaying, wsStatus]);

  const displayStatusText = useMemo(() => {
    if (audioPlayer.isPlaying) return "Speaking...";
    // Backend may send "speaking" status text before audio starts; show thinking text instead
    if (wsStatus === "speaking") return "Thinking...";
    return statusText;
  }, [audioPlayer.isPlaying, wsStatus, statusText]);

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1 className={styles.title}>Lovvit Archive</h1>
        <p className={styles.subtitle}>English conversational AI assistant</p>
      </header>

      <main className={styles.main}>
        {/* Left: Avatar & Status */}
        <aside className={styles.avatarSection}>
          <RabbitAvatar
            emotion={emotion}
            status={status}
            statusText={displayStatusText}
            isConnected={isConnected}
          />

          {audioPlayer.isPlaying && (
            <div className={styles.audioIndicator}>
              <span className={styles.audioWave}>🔊</span>
              <span>Playing audio...</span>
            </div>
          )}

          {error && (
            <div className={styles.error}>
              <span>⚠️</span>
              <span>{error}</span>
            </div>
          )}

          <WorkflowTimingDisplay timing={workflowTiming} />
        </aside>

        {/* Center: Chat (text only) */}
        <section className={styles.chatSection}>
          <ChatHistory
            messages={messages}
            userId={userId}
            onSaveToArchive={handleSaveToArchive}
            textOnly={true}
          />
          {/* Focus strip - shows when an item is selected via voice/touch */}
          {focusedItem && (
            <div className={styles.focusStrip}>
              <span className={styles.focusNumber}>{focusedItem.index + 1}</span>
              <span className={styles.focusTitle}>{focusedItem.name}</span>
              <div className={styles.focusActions}>
                <button
                  className={`${styles.focusBtn} ${styles.focusBtnSave}`}
                  onClick={() => handleCardSelect(focusedItem.index, focusedItem.itemId, "save")}
                >
                  Save
                </button>
                <button
                  className={`${styles.focusBtn} ${styles.focusBtnDetail}`}
                  onClick={() => handleCardSelect(focusedItem.index, focusedItem.itemId, "detail")}
                >
                  Details
                </button>
              </div>
            </div>
          )}
          <ChatInput
            onSendMessage={sendMessage}
            status={status}
            disabled={!isConnected}
            isListening={transcribe.isListening}
            onStartListening={transcribe.startListening}
            onStopListening={transcribe.stopListening}
            interimTranscript={transcribe.interimTranscript}
            voiceDetected={voiceDetected}
            transcribeError={transcribe.error}
          />
        </section>

        {/* Right: Search Results Panel (components only) */}
        <aside className={styles.resultsSection}>
          <SearchResultsPanel
            messages={messages}
            userId={userId}
            onSaveToArchive={handleSaveToArchive}
            selectedIndex={selectedResultIndex}
            onCardSelect={handleCardSelect}
          />
        </aside>
      </main>
    </div>
  );
}
