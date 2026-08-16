/**
 * Text-to-Speech via 9Router /v1/audio/speech
 *
 * Uses OpenAI-compatible TTS endpoint routed through 9Router
 * (Edge TTS, OpenAI, ElevenLabs, Google TTS, etc.)
 */

import { config } from "../../config/index.js";
import { createLogger } from "../../utils/logger.js";
import type { EmotionType, TTSOptions } from "../../types/index.js";
import { getNineRouterConfig, nineRouterHeaders, parseNineRouterError } from "./client.js";

const log = createLogger("NineRouterTTS");

const VOICES = {
  female: () => config.ninerouter.ttsVoiceFemale,
  male: () => config.ninerouter.ttsVoiceMale,
} as const;

export async function synthesizeSpeech(
  text: string,
  options: TTSOptions = {}
): Promise<Buffer> {
  const { voice = "female" } = options;
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("TTS skipped: empty input text");
  }

  const { baseUrl } = getNineRouterConfig();
  const model = VOICES[voice]();
  const startTime = performance.now();
  const textPreview = trimmed.length > 30 ? trimmed.slice(0, 30) + "..." : trimmed;

  log.debug(`TTS request START: "${textPreview}" (${trimmed.length} chars, model: ${model})`);

  const response = await fetch(`${baseUrl}/v1/audio/speech`, {
    method: "POST",
    headers: nineRouterHeaders(),
    body: JSON.stringify({ model, input: trimmed }),
  });

  if (!response.ok) {
    const message = await parseNineRouterError(response);
    log.error("9Router TTS error:", message);
    throw new Error(`9Router TTS failed: ${message}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  const durationMs = Math.round(performance.now() - startTime);
  const audioKB = Math.round(audioBuffer.length / 1024);

  if (durationMs > 500) {
    log.warn(`TTS request SLOW: ${durationMs}ms for "${textPreview}" (${trimmed.length} chars → ${audioKB}KB)`);
  } else {
    log.debug(`TTS request END: ${durationMs}ms for "${textPreview}" (${trimmed.length} chars → ${audioKB}KB)`);
  }

  return audioBuffer;
}

export async function synthesizeSpeechBase64(
  text: string,
  options: TTSOptions = {}
): Promise<string> {
  const audioBuffer = await synthesizeSpeech(text, options);
  return audioBuffer.toString("base64");
}

export async function synthesizeSpeechWithPrompt(
  text: string,
  _prompt: string,
  voice: "female" | "male" = "female"
): Promise<Buffer> {
  return synthesizeSpeech(text, { voice });
}

export async function synthesizeSpeechWithMarkup(
  text: string,
  _emotion: EmotionType = "neutral",
  voice: "female" | "male" = "female"
): Promise<Buffer> {
  return synthesizeSpeech(text, { voice });
}

export async function testTTS(): Promise<boolean> {
  try {
    log.info("Testing 9Router TTS...");
    const audio = await synthesizeSpeech("Hello", { voice: "female", emotion: "neutral" });
    log.info(`Test passed: Generated ${audio.length} bytes`);
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("Test failed:", message);
    return false;
  }
}

export function getEmotionPrompt(_emotion: EmotionType): string {
  return "";
}

export function getAvailableVoices(): typeof VOICES {
  return VOICES;
}
