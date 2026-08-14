/**
 * Frontend STT transcript validation — blocks hallucinated / noise transcripts.
 */

const OBVIOUS_HALLUCINATION_PATTERNS: RegExp[] = [
  /thank(s|\s*you)\s*(for\s*)?(watching|listening|viewing)/i,
  /please\s*(like\s*and\s*)?subscribe/i,
  /subtitles?\s*(by|from|amara)/i,
  /amara\.org/i,
  /^\s*[\[(【].*[\])】]\s*$/,
  /^[\s.\-–—_,!?…。、]+$/,
  /copyright/i,
  /all rights reserved/i,
  /ご視聴ありがとう/,
  /ご清聴ありがとう/,
  /チャンネル登録/,
  /字幕/,
];

const SHORT_FILLER_PATTERNS: RegExp[] = [
  /^(you|the|a|an|um+|uh+|hmm+|oh+|ah+|er+|mhm+)\s*[.!?]*$/i,
  /^(thanks|thank you)[.!?\s]*$/i,
  /^(bye|goodbye)[.!?\s]*$/i,
  /^(okay|ok)[.!?\s]*$/i,
  /^(hello|hi)[.!?\s]*$/i,
  /^(yes|no|yeah|nope)[.!?\s]*$/i,
];

export function isLikelyHallucination(
  text: string,
  options?: { isFinal?: boolean; hadSpeechEnergy?: boolean }
): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;

  // Single ASCII glyph is noise; 2+ chars ("hi", "no", "Hello?") can be real speech.
  if (trimmed.length < 2 && !/^[\u3040-\u30ff\u4e00-\u9fff]$/.test(trimmed)) {
    return true;
  }

  if (/^(.)\1{2,}$/.test(trimmed.replace(/\s/g, ""))) {
    return true;
  }

  if (OBVIOUS_HALLUCINATION_PATTERNS.some((p) => p.test(trimmed))) {
    return true;
  }

  const hadEnergy = options?.hadSpeechEnergy === true;
  if (!hadEnergy && SHORT_FILLER_PATTERNS.some((p) => p.test(trimmed))) {
    return true;
  }
  if (!options?.isFinal && !hadEnergy && trimmed.length < 5) {
    return true;
  }

  return false;
}

/** Returns cleaned text or null if transcript should be rejected. */
export function sanitizeTranscript(
  text: string,
  isFinal: boolean,
  hadSpeechEnergy = true
): string | null {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (!cleaned) return null;
  if (isLikelyHallucination(cleaned, { isFinal, hadSpeechEnergy })) return null;
  if (!isFinal && cleaned.length < 2) return null;
  return cleaned;
}
