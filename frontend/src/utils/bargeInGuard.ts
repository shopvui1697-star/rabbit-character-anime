/**
 * Echo protection — matches transcript against actual TTS content spoken (not phrase blocklists).
 */

import { createLogger } from "@/utils/logger";

const log = createLogger("BargeInGuard");

const COOLDOWN_MS = parseInt(process.env.NEXT_PUBLIC_BARGE_IN_COOLDOWN_MS || "600", 10);
const SPEAKING_MIN_CHARS = parseInt(
  process.env.NEXT_PUBLIC_BARGE_IN_SPEAKING_MIN_CHARS || "4",
  10
);
const MAX_TTS_HISTORY = 24;
const MIN_ECHO_SUBSTRING_LEN = 16;
const TTS_HISTORY_TTL_MS = parseInt(process.env.NEXT_PUBLIC_ECHO_HISTORY_TTL_MS || "8000", 10);

let lastTtsPlaybackStartMs = 0;
let historyClearTimer: ReturnType<typeof setTimeout> | null = null;
const recentTtsTexts: string[] = [];

function cancelHistoryClear(): void {
  if (historyClearTimer) {
    clearTimeout(historyClearTimer);
    historyClearTimer = null;
  }
}

function scheduleHistoryClear(): void {
  cancelHistoryClear();
  historyClearTimer = setTimeout(() => {
    recentTtsTexts.length = 0;
    historyClearTimer = null;
  }, TTS_HISTORY_TTL_MS);
}

export function notifyTtsPlaybackStarted(): void {
  lastTtsPlaybackStartMs = Date.now();
  cancelHistoryClear();
}

export function notifyTtsPlaybackEnded(): void {
  scheduleHistoryClear();
}

export function registerTtsContent(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  cancelHistoryClear();
  recentTtsTexts.push(trimmed);
  if (recentTtsTexts.length > MAX_TTS_HISTORY) recentTtsTexts.shift();
}

export function clearTtsContent(): void {
  cancelHistoryClear();
  recentTtsTexts.length = 0;
  lastTtsPlaybackStartMs = 0;
}

export function normalizeTranscript(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function wordTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\p{P}]+/u)
    .filter((w) => w.length > 1);
}

/** True when transcript matches recent TTS output (acoustic echo transcribed by Whisper). */
export function isLikelyEcho(transcript: string): boolean {
  if (recentTtsTexts.length === 0) return false;

  const norm = normalizeTranscript(transcript);
  if (norm.length < 2) return false;

  const combined = recentTtsTexts.join(" ");
  const normCombined = normalizeTranscript(combined);

  if (norm.length >= MIN_ECHO_SUBSTRING_LEN && normCombined.includes(norm)) {
    log.debug(`Echo filter: combined substring "${transcript}"`);
    return true;
  }

  const tWords = wordTokens(transcript);
  if (tWords.length >= 3) {
    const combinedWords = new Set(wordTokens(combined));
    const overlap = tWords.filter((w) => combinedWords.has(w)).length;
    if (overlap / tWords.length >= 0.5) {
      log.debug(`Echo filter: overlap ${overlap}/${tWords.length} "${transcript}"`);
      return true;
    }
  }

  for (const ttsText of recentTtsTexts) {
    const normTts = normalizeTranscript(ttsText);
    if (!normTts) continue;
    if (normTts.length >= 12 && norm.includes(normTts)) return true;
    if (norm.length >= MIN_ECHO_SUBSTRING_LEN && normTts.includes(norm)) return true;
    const prefixLen = Math.min(norm.length, normTts.length, 16);
    if (prefixLen >= 10 && norm.slice(0, prefixLen) === normTts.slice(0, prefixLen)) return true;
  }

  return false;
}

export function isRepeatSubmission(previous: string, next: string): boolean {
  const a = normalizeTranscript(previous);
  const b = normalizeTranscript(next);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 4 && longer.startsWith(shorter)) {
    const extra = (longer.length - shorter.length) / longer.length;
    if (extra <= 0.25) return true;
  }
  return false;
}

export function isInTtsCooldown(): boolean {
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

  if (!aiSpeaking) return { allowed: true };

  if (!isFinal) {
    const minChars = Math.max(earlyMinChars, SPEAKING_MIN_CHARS);
    if (trimmed.length < minChars) return { allowed: false, reason: "min_chars" };
    if (isInTtsCooldown()) return { allowed: false, reason: "cooldown" };
  }

  return { allowed: true };
}
