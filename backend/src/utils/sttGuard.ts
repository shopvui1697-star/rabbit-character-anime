/**
 * STT anti-hallucination guards for Whisper / buffered STT.
 *
 * Whisper hallucinates on silence/noise — common outputs like
 * "Thank you for watching", "Subtitles by...", etc.
 */

/** RMS below this → treat as silence (PCM16 normalized 0–1). */
export const STT_MIN_SPEECH_RMS = parseFloat(process.env.STT_MIN_SPEECH_RMS || "0.012");

/** Always reject — classic Whisper silence hallucinations. */
const OBVIOUS_HALLUCINATION_PATTERNS: RegExp[] = [
  /thank(s|\s*you)\s*(for\s*)?(watching|listening|viewing)/i,
  /please\s*(like\s*and\s*)?subscribe/i,
  /subtitles?\s*(by|from|amara)/i,
  /amara\.org/i,
  /^\s*[\[(【].*[\])】]\s*$/,
  /^[\s.\-–—_,!?…。、]+$/,
  /copyright/i,
  /all rights reserved/i,
  /transcript/i,
  /silence/i,
  /ご視聴ありがとう/,
  /ご清聴ありがとう/,
  /チャンネル登録/,
  /字幕/,
  /お疲れ様でした/,
];

/** Reject only when the clip had no speech energy — valid short user utterances otherwise. */
const SHORT_FILLER_PATTERNS: RegExp[] = [
  /^(you|the|a|an|um+|uh+|hmm+|oh+|ah+|er+|mhm+)\s*[.!?]*$/i,
  /^(thanks|thank you)[.!?\s]*$/i,
  /^(bye|goodbye)[.!?\s]*$/i,
  /^(okay|ok)[.!?\s]*$/i,
  /^(hello|hi)[.!?\s]*$/i,
  /^(yes|no|yeah|nope)[.!?\s]*$/i,
];

/** Compute RMS of PCM16 mono buffer (samples normalized to -1..1). */
export function computePcm16Rms(pcm: Buffer): number {
  if (pcm.length < 2) return 0;

  const sampleCount = Math.floor(pcm.length / 2);
  if (sampleCount === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = pcm.readInt16LE(i * 2) / 32768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

export function hasSpeechEnergy(pcm: Buffer, threshold = STT_MIN_SPEECH_RMS): boolean {
  return computePcm16Rms(pcm) >= threshold;
}

/** Returns true if text looks like a Whisper/noise hallucination. */
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

  for (const pattern of OBVIOUS_HALLUCINATION_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  // Reject filler hallucinations when the current audio window has no speech energy.
  const hadEnergy = options?.hadSpeechEnergy === true;
  if (!hadEnergy) {
    for (const pattern of SHORT_FILLER_PATTERNS) {
      if (pattern.test(trimmed)) return true;
    }
  }

  // Interim without speech energy — Whisper silence hallucination
  if (!options?.isFinal && !hadEnergy) {
    return true;
  }

  return false;
}

/**
 * Validate transcript before emitting to client.
 * Returns cleaned text, or null if rejected.
 */
export function sanitizeTranscript(
  text: string,
  options?: { isFinal?: boolean; hadSpeechEnergy?: boolean }
): string | null {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (!cleaned) return null;

  if (isLikelyHallucination(cleaned, {
    isFinal: options?.isFinal,
    hadSpeechEnergy: options?.hadSpeechEnergy,
  })) {
    return null;
  }

  // Final transcript on silent audio — reject unless explicitly had energy
  if (options?.isFinal && options.hadSpeechEnergy === false) {
    return null;
  }

  // Interim must have meaningful length
  if (!options?.isFinal && cleaned.length < 2) {
    return null;
  }

  return cleaned;
}
