"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { createLogger } from "@/utils/logger";
import {
  playAudioFromBase64,
  setSharedVolume,
} from "@/utils/audioUnlock";

const log = createLogger("AudioPlayer");

interface AudioChunk {
  data: string;
  format: string;
  index: number;
  total: number;
  isLast: boolean;
  responseId?: string;
  sentence?: string;  // Sentence text for synchronized text+audio display
}

interface UseAudioPlayerOptions {
  /** Called when a chunk starts playing, with its sentence text (for sentence sync display) */
  onSentencePlay?: (sentence: string, index: number) => void;
  /** Called when TTS playback begins (each chunk/full audio) — for echo guard cooldown */
  onPlaybackStart?: () => void;
}

interface UseAudioPlayerReturn {
  isPlaying: boolean;
  play: (base64Audio: string, format?: string, responseId?: string, isProtected?: boolean) => Promise<void>;
  playChunk: (chunk: AudioChunk) => void;
  stop: () => void;
  cancelAllAudio: () => void;  // Call when user sends new message
  setVolume: (volume: number) => void;
}

export function useAudioPlayer(options?: UseAudioPlayerOptions): UseAudioPlayerReturn {
  const [isPlaying, setIsPlaying] = useState(false);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);

  // Keep callback refs updated (avoids stale closures)
  const onSentencePlayRef = useRef(options?.onSentencePlay);
  onSentencePlayRef.current = options?.onSentencePlay;
  const onPlaybackStartRef = useRef(options?.onPlaybackStart);
  onPlaybackStartRef.current = options?.onPlaybackStart;

  // Queue for chunked audio playback
  const audioQueueRef = useRef<Map<number, string>>(new Map());
  const sentenceQueueRef = useRef<Map<number, string>>(new Map()); // Sentence text per chunk index
  const currentChunkIndexRef = useRef(0);
  const totalChunksRef = useRef(0);
  const isPlayingQueueRef = useRef(false);
  const isProcessingChunkRef = useRef(false);

  // Simple response tracking: only accept audio matching this responseId
  // null = accept any, "__CANCELLED__" = reject all
  const acceptedResponseIdRef = useRef<string | null>(null);

  // Protected audio (long-waiting) - must play to completion + delay
  const isProtectedAudioRef = useRef(false);
  const protectedAudioQueueRef = useRef<Array<{ base64Audio: string; format: string; responseId?: string }>>([]);
  const POST_PROTECTED_DELAY = 400; // 400ms delay after protected audio completes

  // Callback ref for processNextChunk (to avoid circular dependencies)
  const processNextChunkRef = useRef<(() => Promise<void>) | null>(null);

  // Safely stop an AudioBufferSourceNode (may throw if already stopped)
  const stopSource = useCallback((source: AudioBufferSourceNode | null) => {
    if (source) {
      try {
        source.stop();
      } catch {
        // Already stopped — ignore
      }
    }
  }, []);

  // Buffer for chunks that arrive before chunk 0 (out-of-order) - declared early for cancelAllAudio
  const pendingChunksRef = useRef<Map<string, AudioChunk[]>>(new Map());

  // Stop all audio and reject future audio until new response starts
  const cancelAllAudio = useCallback(() => {
    log.debug("CANCEL ALL: Stopping audio and rejecting future audio");

    // Stop current audio (including protected audio)
    stopSource(sourceRef.current);
    sourceRef.current = null;

    // Clear queue
    isPlayingQueueRef.current = false;
    isProcessingChunkRef.current = false;
    audioQueueRef.current.clear();
    sentenceQueueRef.current.clear();
    currentChunkIndexRef.current = 0;
    totalChunksRef.current = 0;

    // Clear protected audio state
    isProtectedAudioRef.current = false;
    protectedAudioQueueRef.current = [];
    
    // Clear pending chunks buffer
    pendingChunksRef.current.clear();

    // Reject all audio until new response with valid responseId
    acceptedResponseIdRef.current = "__CANCELLED__";
    setIsPlaying(false);
  }, [stopSource]);

  // Play full audio (for greeting, long_waiting, sequential TTS)
  const play = useCallback(
    async (base64Audio: string, format: string = "mp3", responseId?: string, isProtected: boolean = false) => {
      // Check if we should accept this audio
      if (acceptedResponseIdRef.current === "__CANCELLED__") {
        // Only accept if it has a responseId (new response starting)
        if (!responseId) {
          log.debug("Rejecting audio - cancelled and no responseId");
          return;
        }
        // New response with responseId - accept it
        log.debug(`Accepting new response: ${responseId.slice(-8)}`);
        acceptedResponseIdRef.current = responseId;
      } else if (acceptedResponseIdRef.current && responseId) {
        // We have an accepted responseId - check if this matches
        if (responseId !== acceptedResponseIdRef.current) {
          log.debug(`Rejecting audio - wrong responseId: got ${responseId.slice(-8)}, want ${acceptedResponseIdRef.current.slice(-8)}`);
          return;
        }
      }

      // Update accepted responseId
      if (responseId) {
        acceptedResponseIdRef.current = responseId;
      }

      // If protected audio is currently playing, queue this audio
      if (isProtectedAudioRef.current && !isProtected) {
        log.debug(`Protected audio playing - queueing result audio (responseId: ${responseId?.slice(-8) || 'none'})`);
        protectedAudioQueueRef.current.push({ base64Audio, format, responseId });
        return;
      }

      try {
        // Stop any currently playing audio (unless it's protected)
        if (sourceRef.current && !isProtectedAudioRef.current) {
          stopSource(sourceRef.current);
          sourceRef.current = null;
        }

        // Clear chunk queue
        isPlayingQueueRef.current = false;
        isProcessingChunkRef.current = false;
        audioQueueRef.current.clear();
        currentChunkIndexRef.current = 0;
        totalChunksRef.current = 0;

        // Mark as protected if this is protected audio
        if (isProtected) {
          log.debug(`Playing protected audio (long-waiting)`);
          isProtectedAudioRef.current = true;
        }

        // Decode and play via Web Audio API
        const { source } = await playAudioFromBase64(base64Audio, format);
        sourceRef.current = source;
        onPlaybackStartRef.current?.();
        setIsPlaying(true);

        source.onended = async () => {
          setIsPlaying(false);

          // If this was protected audio, wait delay then play queued audio
          if (isProtected) {
            log.debug(`Protected audio ended, waiting ${POST_PROTECTED_DELAY}ms before playing result...`);
            isProtectedAudioRef.current = false;

            // Wait the post-protected delay
            await new Promise(resolve => setTimeout(resolve, POST_PROTECTED_DELAY));

            // Check if we have buffered chunks (parallel TTS)
            if (audioQueueRef.current.size > 0 && totalChunksRef.current > 0) {
              log.debug(`Playing buffered chunks (${audioQueueRef.current.size}/${totalChunksRef.current})`);
              isPlayingQueueRef.current = true;
              isProcessingChunkRef.current = false;
              currentChunkIndexRef.current = 0;
              setIsPlaying(true);
              if (processNextChunkRef.current) {
                processNextChunkRef.current();
              }
            }
            // Otherwise check for queued full audio
            else if (protectedAudioQueueRef.current.length > 0) {
              const queued = protectedAudioQueueRef.current.shift();
              if (queued) {
                log.debug(`Playing queued result audio (responseId: ${queued.responseId?.slice(-8) || 'none'})`);
                play(queued.base64Audio, queued.format, queued.responseId, false);
              }
            }
          }
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.error(`Failed to play audio (responseId: ${responseId?.slice(-8) || 'none'}, protected: ${isProtected}):`, errorMsg);
        
        // Log additional context for debugging
        if (base64Audio) {
          log.debug(`Audio data length: ${base64Audio.length} chars, format: ${format}`);
        } else {
          log.error("Audio data is empty or undefined");
        }
        
        setIsPlaying(false);
        isProtectedAudioRef.current = false;
      }
    },
    [stopSource]
  );

  // Track chunk playback timing
  const chunkPlayStartRef = useRef<number>(0);
  const lastChunkEndRef = useRef<number>(0);

  // Process next chunk in queue
  const processNextChunk = useCallback(async () => {
    if (!isPlayingQueueRef.current) return;
    if (isProcessingChunkRef.current) return;
    isProcessingChunkRef.current = true;

    const nextIndex = currentChunkIndexRef.current;
    const audioData = audioQueueRef.current.get(nextIndex);
    const now = performance.now();

    if (!audioData) {
      if (nextIndex >= totalChunksRef.current && totalChunksRef.current > 0) {
        // All chunks played
        const totalPlayTime = Math.round(now - firstChunkTimeRef.current);
        log.debug(`✅ All ${totalChunksRef.current} chunks played (total: ${totalPlayTime}ms)`);
        isPlayingQueueRef.current = false;
        audioQueueRef.current.clear();
        sentenceQueueRef.current.clear();
        currentChunkIndexRef.current = 0;
        totalChunksRef.current = 0;
        chunkArrivalTimesRef.current.clear();
        setIsPlaying(false);
      } else {
        // Waiting for chunk - log gap
        const waitingSince = lastChunkEndRef.current > 0 ? Math.round(now - lastChunkEndRef.current) : 0;
        log.warn(`⏳ Waiting for chunk ${nextIndex}/${totalChunksRef.current} (gap: ${waitingSince}ms)`);
      }
      isProcessingChunkRef.current = false;
      return;
    }

    // Calculate gap between chunks
    const gap = lastChunkEndRef.current > 0 ? Math.round(now - lastChunkEndRef.current) : 0;
    if (gap > 50 && nextIndex > 0) {
      log.warn(`⚠️ Gap before chunk ${nextIndex}: ${gap}ms (not smooth)`);
    }
    
    chunkPlayStartRef.current = now;
    log.debug(`▶️ Playing chunk ${nextIndex}/${totalChunksRef.current}`);
    onPlaybackStartRef.current?.();

    // Notify parent: sentence text should be displayed NOW (sync with audio start)
    const sentenceText = sentenceQueueRef.current.get(nextIndex);
    if (sentenceText && onSentencePlayRef.current) {
      onSentencePlayRef.current(sentenceText, nextIndex);
    }

    try {
      const { source } = await playAudioFromBase64(audioData, "mp3");
      sourceRef.current = source;

      source.onended = () => {
        const playDuration = Math.round(performance.now() - chunkPlayStartRef.current);
        lastChunkEndRef.current = performance.now();
        log.debug(`⏹️ Chunk ${nextIndex} ended (played: ${playDuration}ms)`);
        
        isProcessingChunkRef.current = false;
        currentChunkIndexRef.current++;
        processNextChunk();
      };
    } catch (error) {
      log.error(`Audio chunk ${nextIndex} failed:`, error);
      lastChunkEndRef.current = performance.now();
      isProcessingChunkRef.current = false;
      currentChunkIndexRef.current++;
      processNextChunk();
    }
  }, []);

  // Track chunk arrival times for timing analysis
  const chunkArrivalTimesRef = useRef<Map<number, number>>(new Map());
  const firstChunkTimeRef = useRef<number>(0);

  // Play audio chunk (for parallel TTS streaming)
  const playChunk = useCallback((chunk: AudioChunk) => {
    const now = performance.now();
    
    // Track timing for first chunk
    if (chunk.index === 0) {
      firstChunkTimeRef.current = now;
      chunkArrivalTimesRef.current.clear();
    }
    
    // Log chunk arrival timing
    const sinceFirst = chunk.index === 0 ? 0 : Math.round(now - firstChunkTimeRef.current);
    chunkArrivalTimesRef.current.set(chunk.index, now);
    log.debug(`📥 Chunk ${chunk.index}/${chunk.total} arrived (+${sinceFirst}ms since chunk 0)`);
    
    // Check if we should accept this chunk
    if (acceptedResponseIdRef.current === "__CANCELLED__") {
      if (!chunk.responseId) {
        log.debug(`Rejecting chunk ${chunk.index} - cancelled and no responseId`);
        return;
      }
      if (chunk.index !== 0) {
        // Buffer this chunk - it arrived before chunk 0
        // We'll process it when chunk 0 arrives
        const pending = pendingChunksRef.current.get(chunk.responseId) || [];
        pending.push(chunk);
        pendingChunksRef.current.set(chunk.responseId, pending);
        log.debug(`Buffering chunk ${chunk.index} - waiting for chunk 0 (responseId: ${chunk.responseId.slice(-8)})`);
        return;
      }
      // Chunk 0 with responseId - new response starting
      log.debug(`Accepting new response from chunk 0: ${chunk.responseId.slice(-8)}`);
      acceptedResponseIdRef.current = chunk.responseId;
    } else if (acceptedResponseIdRef.current && chunk.responseId) {
      if (chunk.responseId !== acceptedResponseIdRef.current) {
        log.debug(`Rejecting chunk ${chunk.index} - wrong responseId`);
        return;
      }
    }

    // If protected audio is playing, buffer chunks but don't start playback yet
    if (isProtectedAudioRef.current) {
      log.debug(`Protected audio playing - buffering chunk ${chunk.index}/${chunk.total}`);
      audioQueueRef.current.set(chunk.index, chunk.data);
      if (chunk.sentence) sentenceQueueRef.current.set(chunk.index, chunk.sentence);
      totalChunksRef.current = chunk.total;

      // If this is chunk 0, mark that we have a pending chunked response
      if (chunk.index === 0 && chunk.responseId) {
        acceptedResponseIdRef.current = chunk.responseId;
      }
      return;
    }

    // Chunk 0 = new response, clear and restart
    if (chunk.index === 0) {
      if (chunk.responseId) {
        acceptedResponseIdRef.current = chunk.responseId;
        log.debug(`Starting response: ${chunk.responseId.slice(-8)}`);
      }

      // Stop current audio
      stopSource(sourceRef.current);
      sourceRef.current = null;

      // Clear and setup new queue
      audioQueueRef.current.clear();
      sentenceQueueRef.current.clear();
      audioQueueRef.current.set(0, chunk.data);
      if (chunk.sentence) sentenceQueueRef.current.set(0, chunk.sentence);
      totalChunksRef.current = chunk.total;
      
      // Check for any chunks that arrived before chunk 0 and add them to queue
      if (chunk.responseId) {
        const pendingForThis = pendingChunksRef.current.get(chunk.responseId);
        if (pendingForThis && pendingForThis.length > 0) {
          log.debug(`Processing ${pendingForThis.length} buffered chunks for response ${chunk.responseId.slice(-8)}`);
          for (const pendingChunk of pendingForThis) {
            audioQueueRef.current.set(pendingChunk.index, pendingChunk.data);
            if (pendingChunk.sentence) sentenceQueueRef.current.set(pendingChunk.index, pendingChunk.sentence);
            log.debug(`Added buffered chunk ${pendingChunk.index} to queue`);
          }
          pendingChunksRef.current.delete(chunk.responseId);
        }
      }
      
      isPlayingQueueRef.current = true;
      isProcessingChunkRef.current = false;
      currentChunkIndexRef.current = 0;
      onPlaybackStartRef.current?.();
      setIsPlaying(true);
      processNextChunk();
      return;
    }

    // Non-zero chunk - add to queue if playing
    if (!isPlayingQueueRef.current) {
      return;
    }

    audioQueueRef.current.set(chunk.index, chunk.data);
    if (chunk.sentence) sentenceQueueRef.current.set(chunk.index, chunk.sentence);
    totalChunksRef.current = chunk.total;

    // If we're waiting for this chunk, process it
    if (!isProcessingChunkRef.current && audioQueueRef.current.has(currentChunkIndexRef.current)) {
      processNextChunk();
    }
  }, [processNextChunk, stopSource]);

  // Stop audio playback
  const stop = useCallback(() => {
    stopSource(sourceRef.current);
    sourceRef.current = null;

    isPlayingQueueRef.current = false;
    isProcessingChunkRef.current = false;
    audioQueueRef.current.clear();
    sentenceQueueRef.current.clear();
    currentChunkIndexRef.current = 0;
    totalChunksRef.current = 0;
    setIsPlaying(false);
  }, [stopSource]);

  // Set volume via shared GainNode
  const setVolume = useCallback((volume: number) => {
    setSharedVolume(volume);
  }, []);

  // Keep processNextChunk ref updated
  useEffect(() => {
    processNextChunkRef.current = processNextChunk;
  }, [processNextChunk]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopSource(sourceRef.current);
      sourceRef.current = null;
    };
  }, [stopSource]);

  return {
    isPlaying,
    play,
    playChunk,
    stop,
    cancelAllAudio,
    setVolume,
  };
}
