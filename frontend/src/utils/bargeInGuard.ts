/**
 * Echo / self-barge-in protection for voice interrupt.
 *
 * Layers:
 * 1. Cooldown after TTS playback starts (speaker → mic delay)
 * 2. Higher character threshold while AI is speaking
 * 3. Content filter — reject transcript that matches recent TTS output
 */

import { createLogger } from "@/utils/logger";

const log = createLogger("BargeInGuard");

const COOLDOWN_MS = parseInt(process.env.NEXT_PUBLIC_BARGE_IN_COOLDOWN_MS || "600", 10);
const SPEAKING_MIN_CHARS = parseInt(
  process.env.NEXT_PUBLIC_BARGE_IN_SPEAKING_MIN_CHARS || "4",
  10
);
const MAX_TTS_HISTORY = 8;

let lastTtsPlaybackStartMs = 0;
const recentTtsTexts: string[] = [];

/** Call when TTS audio begins playing (each chunk). */
export function notifyTtsPlaybackStarted(): void {
  lastTtsPlaybackStartMs = Date.now();
}

/** Track sentences the AI is speaking (for echo matching). */
export function registerTtsContent(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  recentTtsTexts.push(trimmed);
  if (recentTtsTexts.length > MAX_TTS_HISTORY) {
    recentTtsTexts.shift();
  }
}

/** Clear TTS history when a response is cancelled or a new turn begins. */
export function clearTtsContent(): void {
  recentTtsTexts.length = 0;
  lastTtsPlaybackStartMs = 0;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

function wordTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\p{P}]+/u)
    .filter((w) => w.length > 1);
}

/**
 * Returns true if transcript likely comes from speaker echo of TTS output.
 */
export function isLikelyEcho(transcript: string): boolean {
  const norm = normalize(transcript);
  if (norm.length < 2) return false;

  for (const ttsText of recentTtsTexts) {
    const normTts = normalize(ttsText);
    if (!normTts) continue;

    // Direct substring match (STT often picks up partial TTS phrases)
    if (normTts.includes(norm) || norm.includes(normTts)) {
      log.debug(`Echo filter: substring match "${transcript}" ↔ TTS`);
      return true;
    }

    // Prefix match — echo often starts at beginning of current sentence
    const prefixLen = Math.min(norm.length, normTts.length, 12);
    if (prefixLen >= 4 && norm.slice(0, prefixLen) === normTts.slice(0, prefixLen)) {
      log.debug(`Echo filter: prefix match "${transcript}" ↔ TTS`);
      return true;
    }

    // Word overlap — >60% of transcript words appear in TTS sentence
    const tWords = wordTokens(transcript);
    if (tWords.length >= 2) {
      const ttsWords = new Set(wordTokens(ttsText));
      const overlap = tWords.filter((w) => ttsWords.has(w)).length;
      if (overlap / tWords.length >= 0.6) {
        log.debug(`Echo filter: word overlap ${overlap}/${tWords.length} "${transcript}"`);
        return true;
      }
    }
  }

  return false;
}

function isInCooldown(): boolean {
  if (lastTtsPlaybackStartMs === 0) return false;
  return Date.now() - lastTtsPlaybackStartMs < COOLDOWN_MS;
}

export interface BargeInCheckOptions {
  text: string;
  isFinal: boolean;
  aiSpeaking: boolean;
  earlyMinChars: number;
}

export interface BargeInCheckResult {
  allowed: boolean;
  reason?: "cooldown" | "min_chars" | "echo";
}

/**
 * Decide whether to act on a transcript for barge-in.
 * Used for both early (stop audio) and final (submit message) paths.
 */
export function checkBargeIn({
  text,
  isFinal,
  aiSpeaking,
  earlyMinChars,
}: BargeInCheckOptions): BargeInCheckResult {
  const trimmed = text.trim();
  if (!trimmed) return { allowed: false, reason: "min_chars" };

  if (isLikelyEcho(trimmed)) {
    return { allowed: false, reason: "echo" };
  }

  if (!aiSpeaking) {
    return { allowed: true };
  }

  // While AI is speaking, require more chars for early barge-in
  if (!isFinal) {
    const minChars = Math.max(earlyMinChars, SPEAKING_MIN_CHARS);
    if (trimmed.length < minChars) {
      return { allowed: false, reason: "min_chars" };
    }
    if (isInCooldown()) {
      return { allowed: false, reason: "cooldown" };
    }
  }

  return { allowed: true };
}
