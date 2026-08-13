"use client";

import { createLogger } from "@/utils/logger";

const log = createLogger("AudioUnlock");

// Shared AudioContext singleton
let sharedAudioContext: AudioContext | null = null;
let sharedGainNode: GainNode | null = null;
let isUnlocked = false;

// Cache for pre-loaded waiting sound AudioBuffers
const waitingBufferCache = new Map<number, AudioBuffer>();

/**
 * Get or create the shared AudioContext.
 * All audio playback should go through this single context.
 */
export function getSharedAudioContext(): AudioContext {
  if (!sharedAudioContext) {
    sharedAudioContext = new AudioContext();
    sharedGainNode = sharedAudioContext.createGain();
    sharedGainNode.connect(sharedAudioContext.destination);
    log.debug("Created shared AudioContext");
  }
  return sharedAudioContext;
}

/**
 * Get the shared GainNode for volume control.
 */
export function getSharedGainNode(): GainNode {
  if (!sharedGainNode) {
    getSharedAudioContext();
  }
  return sharedGainNode!;
}

/**
 * Unlock the AudioContext for iOS Safari.
 * Must be called from a user gesture handler (touchstart/click).
 * Once unlocked, all subsequent AudioBufferSourceNode.start() calls
 * work without further gestures — even from setTimeout or WebSocket handlers.
 */
export async function unlockAudio(): Promise<void> {
  if (isUnlocked) return;

  const ctx = getSharedAudioContext();

  try {
    // Resume if suspended (required on iOS)
    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    // Play a silent buffer to fully unlock on iOS
    const silentBuffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = silentBuffer;
    source.connect(ctx.destination);
    source.start(0);

    isUnlocked = true;
    log.debug("AudioContext unlocked successfully");
  } catch (err) {
    log.error("Failed to unlock AudioContext:", err);
  }
}

/**
 * Check if the AudioContext has been unlocked.
 */
export function isAudioUnlocked(): boolean {
  return isUnlocked;
}

/**
 * Play audio from a base64-encoded string using the Web Audio API.
 * Returns the source node and estimated duration for stop/onended control.
 */
export async function playAudioFromBase64(
  base64: string,
  format: string = "mp3"
): Promise<{ source: AudioBufferSourceNode; duration: number }> {
  const ctx = getSharedAudioContext();
  const gainNode = getSharedGainNode();

  try {
    // Validate input
    if (!base64 || base64.length === 0) {
      throw new Error("Empty base64 audio data");
    }

    // Resume context if suspended (e.g., after returning from background)
    if (ctx.state === "suspended") {
      log.debug("AudioContext suspended, resuming...");
      await ctx.resume();
    }

    // Decode base64 to ArrayBuffer
    let binaryString: string;
    try {
      binaryString = atob(base64);
    } catch (err) {
      throw new Error(`Invalid base64 encoding: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (binaryString.length === 0) {
      throw new Error("Decoded base64 resulted in empty data");
    }

    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    log.debug(`Decoding audio: ${bytes.length} bytes, format: ${format}`);

    // Decode audio data to AudioBuffer
    let audioBuffer: AudioBuffer;
    try {
      audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
    } catch (err) {
      throw new Error(`Failed to decode audio data: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      throw new Error("Decoded audio buffer is empty");
    }

    // Create source node and connect through gain
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(gainNode);
    source.start(0);

    log.debug(`Playing audio: ${audioBuffer.duration.toFixed(2)}s`);

    return { source, duration: audioBuffer.duration };
  } catch (error) {
    // Re-throw with context
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error(`playAudioFromBase64 failed: ${errorMsg}`);
    throw new Error(`Audio playback failed: ${errorMsg}`);
  }
}

/**
 * Play an AudioBuffer directly using the shared context.
 * Used for pre-loaded waiting sounds.
 */
export function playAudioBuffer(
  buffer: AudioBuffer
): { source: AudioBufferSourceNode; duration: number } {
  const ctx = getSharedAudioContext();
  const gainNode = getSharedGainNode();

  // Resume context if needed (sync attempt — caller should handle async resume)
  if (ctx.state === "suspended") {
    ctx.resume();
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(gainNode);
  source.start(0);

  return { source, duration: buffer.duration };
}

/**
 * Preload all waiting sound files into AudioBuffer cache.
 * Call after unlocking the AudioContext.
 */
export async function preloadWaitingSounds(count: number): Promise<void> {
  const ctx = getSharedAudioContext();

  log.debug(`Preloading ${count} waiting sounds...`);

  const promises = Array.from({ length: count }, async (_, i) => {
    try {
      const response = await fetch(`/waiting-short/${i}.mp3`);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      waitingBufferCache.set(i, audioBuffer);
    } catch (err) {
      log.warn(`Failed to preload waiting sound ${i}:`, err);
    }
  });

  await Promise.all(promises);
  log.debug(`Preloaded ${waitingBufferCache.size}/${count} waiting sounds`);
}

/**
 * Get a cached waiting sound AudioBuffer by index.
 */
export function getWaitingBuffer(index: number): AudioBuffer | null {
  return waitingBufferCache.get(index) ?? null;
}

/**
 * Set up visibility change handler to resume AudioContext
 * when the app returns to foreground (iOS PWA).
 */
export function setupVisibilityHandler(): () => void {
  const handler = () => {
    if (document.visibilityState === "visible" && sharedAudioContext) {
      if (sharedAudioContext.state === "suspended") {
        log.debug("App foregrounded — resuming AudioContext");
        sharedAudioContext.resume();
      }
    }
  };

  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}

let savedVolume = 1.0;
let isDucked = false;

/**
 * Set volume (0.0 to 1.0) on the shared GainNode.
 */
export function setSharedVolume(volume: number): void {
  const clamped = Math.max(0, Math.min(1, volume));
  savedVolume = clamped;
  const gainNode = getSharedGainNode();
  gainNode.gain.value = clamped;
  isDucked = false;
}

/**
 * Lower TTS volume while mic is active during AI speech — reduces echo pickup.
 */
export function duckSharedVolume(duckLevel: number, rampMs = 80): void {
  const clamped = Math.max(0, Math.min(1, duckLevel));
  const gainNode = getSharedGainNode();
  const ctx = getSharedAudioContext();

  if (!isDucked) {
    savedVolume = gainNode.gain.value;
    isDucked = true;
  }

  gainNode.gain.cancelScheduledValues(ctx.currentTime);
  gainNode.gain.setValueAtTime(gainNode.gain.value, ctx.currentTime);
  gainNode.gain.linearRampToValueAtTime(clamped, ctx.currentTime + rampMs / 1000);
}

/**
 * Restore TTS volume after ducking.
 */
export function restoreSharedVolume(rampMs = 120): void {
  if (!isDucked) return;

  const gainNode = getSharedGainNode();
  const ctx = getSharedAudioContext();
  gainNode.gain.cancelScheduledValues(ctx.currentTime);
  gainNode.gain.setValueAtTime(gainNode.gain.value, ctx.currentTime);
  gainNode.gain.linearRampToValueAtTime(savedVolume, ctx.currentTime + rampMs / 1000);
  isDucked = false;
}

export function isVolumeDucked(): boolean {
  return isDucked;
}
