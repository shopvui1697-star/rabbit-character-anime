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
  isRepeatSubmission,
  notifyTtsPlaybackEnded,
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

  // Track the current sentence-sync message ID (set when sentenceSync assistant_message arrives)
  const sentenceSyncMessageIdRef = useRef<string | null>(null);
  // Ref-based bridge to call appendToMessage from useAudioPlayer callback
  const appendToMessageRef = useRef<((messageId: string, sentence: string) => void) | null>(null);
  // Track if early barge-in was triggered (reset on final transcript)
  const earlyBargeInTriggeredRef = useRef(false);

  const lastSubmittedRef = useRef({ text: "", at: 0 });
  const submitLockRef = useRef(false);
  const discardSttRef = useRef<(() => void) | null>(null);
  const bargeInSttRef = useRef<(() => void) | null>(null);
  const voiceActiveRef = useRef(false);

  const audioPlayer = useAudioPlayer({
    onPlaybackStart: () => {
      notifyTtsPlaybackStarted();
      discardSttRef.current?.();
    },
    onPlaybackEnd: () => {
      notifyTtsPlaybackEnded();
      // Don't wipe user speech that started as AI finished — only clear leftover echo
      if (!earlyBargeInTriggeredRef.current && !voiceActiveRef.current) {
        discardSttRef.current?.();
      }
      earlyBargeInTriggeredRef.current = false;
    },
    onSentencePlay: (sentence, index) => {
      registerTtsContent(sentence);
      // When audio chunk N starts playing, display its sentence text
      const messageId = sentenceSyncMessageIdRef.current;
      if (messageId && appendToMessageRef.current) {
        log.debug(`Sentence sync: displaying sentence #${index} for message ${messageId.slice(-8)}`);
        appendToMessageRef.current(messageId, sentence);
      }
    },
  });
  const [voiceDetected, setVoiceDetected] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  
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
    onSentenceSync: (messageId) => {
      // Sentence-sync mode: text will be revealed sentence-by-sentence with audio
      log.debug(`Sentence sync mode for message: ${messageId.slice(-8)}`);
      sentenceSyncMessageIdRef.current = messageId;
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
    restoreSharedVolume();

    // Reset sentence sync state for new response
    sentenceSyncMessageIdRef.current = null;

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

  // Early barge-in: post-AEC VAD detects speech over TTS → stop playback + relax AEC
  useEffect(() => {
    const aiSpeaking = audioPlayer.isPlaying;
    if (voiceActive && aiSpeaking && !earlyBargeInTriggeredRef.current) {
      log.debug("🟡 EARLY BARGE-IN (VAD): stopping TTS playback");
      audioPlayer.cancelAllAudio();
      restoreSharedVolume();
      earlyBargeInTriggeredRef.current = true;
      bargeInSttRef.current?.();
    }
  }, [voiceActive, audioPlayer.isPlaying, wsStatus, audioPlayer]);

  // Google STT for voice input (streamed via backend WebSocket)
  const transcribe = useGoogleSTT({
    config: GOOGLE_STT_CONFIG,
    wsRef,
    wsConnected: isConnected,
    stopOnTabHidden: true,
    isTtsPlaying: useCallback(() => audioPlayer.isPlaying, [audioPlayer.isPlaying]),
    onTranscript: useCallback((text: string, isFinal: boolean) => {
      log.debug(`📝 Transcript ${isFinal ? "(final)" : "(interim)"}:`, text);

      if (!isFinal) return;

      if (submitLockRef.current) return;

      const trimmedText = text.trim();
      const aiSpeaking = audioPlayer.isPlaying || wsStatus === "speaking";

      const bargeInCheck = checkBargeIn({
        text: trimmedText,
        isFinal: true,
        aiSpeaking,
        earlyMinChars: 2,
      });

      if (!bargeInCheck.allowed) {
        log.debug(`🚫 Blocked transcript (${bargeInCheck.reason}): "${trimmedText}"`);
        earlyBargeInTriggeredRef.current = false;
        return;
      }

      if (!trimmedText || trimmedText.length < BARGE_IN_MIN_CHARS) {
        log.debug(`⏭️ Transcript too short (${trimmedText.length} chars), ignoring`);
        earlyBargeInTriggeredRef.current = false;
        return;
      }

      if (
        Date.now() - lastSubmittedRef.current.at < 15000 &&
        isRepeatSubmission(lastSubmittedRef.current.text, trimmedText)
      ) {
        log.debug(`⏭️ Duplicate transcript skipped: "${trimmedText}"`);
        earlyBargeInTriggeredRef.current = false;
        return;
      }

      submitLockRef.current = true;
      earlyBargeInTriggeredRef.current = false;
      lastSubmittedRef.current = { text: trimmedText, at: Date.now() };

      if (aiSpeaking) {
        log.debug("🔇 REGULAR BARGE-IN: Stopping audio");
        audioPlayer.cancelAllAudio();
        restoreSharedVolume();
      }

      log.debug(`✅ Submitting: "${trimmedText}"`);
      sendMessage(trimmedText)
        .catch((err) => {
          log.error("Failed to send message:", err);
        })
        .finally(() => {
          submitLockRef.current = false;
        });
    }, [audioPlayer, wsStatus, sendMessage]),
    onVoiceActivity: useCallback((active: boolean) => {
      voiceActiveRef.current = active;
      setVoiceActive(active);
    }, []),
    onError: useCallback((err: Error) => {
      log.error("Google STT error:", err);
    }, []),
  });

  useEffect(() => {
    discardSttRef.current = transcribe.discardUtterance;
    bargeInSttRef.current = transcribe.enterBargeInMode;
  }, [transcribe.discardUtterance, transcribe.enterBargeInMode]);

  // Register full assistant reply for echo matching (Whisper often captures multi-sentence TTS)
  useEffect(() => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant?.content) {
      registerTtsContent(lastAssistant.content);
    }
  }, [messages]);

  // Duck TTS while mic is on and AI is speaking — single fixed level
  useEffect(() => {
    const shouldDuck = transcribe.isListening && audioPlayer.isPlaying;
    if (shouldDuck) {
      duckSharedVolume(voiceActive ? TTS_VAD_DUCK_VOLUME : TTS_DUCK_VOLUME);
    } else {
      restoreSharedVolume();
    }
  }, [transcribe.isListening, audioPlayer.isPlaying, voiceActive]);

  useEffect(() => {
    setVoiceDetected(voiceActive || transcribe.interimTranscript.length > 0);
  }, [voiceActive, transcribe.interimTranscript]);

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
            interimTranscript={transcribe.isListening ? transcribe.interimTranscript : ""}
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
