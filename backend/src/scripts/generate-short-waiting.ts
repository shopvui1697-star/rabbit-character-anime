/**
 * Generate Short Waiting Audio Files
 * 
 * Creates short acknowledgment sounds using Google TTS
 * with the same voice as the main responses for consistency.
 * 
 * IMPORTANT: Uses synthesizeSpeech() which outputs MP3 —
 * this MUST match the realtime TTS settings in ninerouter/tts.ts
 * to ensure uniform voice (same encoding, sample rate, and loudness).
 * Frontend expects .mp3 files at /waiting-short/{i}.mp3
 * 
 * Usage: npm run generate:short-waiting
 */

import { synthesizeSpeech } from "../services/ninerouter/tts.js";
import { writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createLogger } from "../utils/logger.js";

const log = createLogger("GenerateShortWaiting");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Output directory (frontend public folder)
const OUTPUT_DIR = join(__dirname, "../../../frontend/public/waiting-short");

// Short waiting phrases (< 1 second each)
const SHORT_WAITING_PHRASES = [
  "Let me check that real quick.",
  "Yeah, I'm looking now.",
  "OK, give me a sec.",
  "On it, I'll search for that.",
  "Let me think about that.",
  "Yeah yeah, I'm on it.",
  "Checking now.",
  "Looking that up.",
  "I'll verify that right away.",
  "Just a sec.",
  "Got it, checking now.",
  "OK, still checking.",
  "Hold on, checking now.",
  "Sure, one moment.",
  "On it now.",
  "Let me confirm that.",
  "No problem, I've got it.",
  "Still checking, just a sec.",
  "Searching now.",
  "Need a moment for this.",
];

/**
 * Generate a single short waiting audio file.
 * 
 * Uses synthesizeSpeech() → MP3/24000Hz/Achernar (same as realtime TTS)
 * to ensure identical voice characteristics and loudness.
 * DO NOT use different encoding or sample rate — it will sound different.
 */
async function generateShortWaiting(
  text: string,
  index: number
): Promise<void> {
  try {
    log.info(`Generating ${index}.mp3: "${text}"`);

    // Same voice + encoding as realtime conversation TTS (MP3/24000Hz/Achernar)
    const audioBuffer = await synthesizeSpeech(text, {
      voice: "female",
    });

    // Ensure output directory exists
    await mkdir(OUTPUT_DIR, { recursive: true });

    // Write as .mp3 — frontend fetches /waiting-short/{i}.mp3
    const outputPath = join(OUTPUT_DIR, `${index}.mp3`);
    await writeFile(outputPath, audioBuffer);

    log.info(`Generated ${index}.mp3 (${audioBuffer.length} bytes)`);
  } catch (error) {
    log.error(`Failed to generate ${index}.mp3:`, error);
    throw error;
  }
}

/**
 * Generate all short waiting audio files
 */
async function generateAll(): Promise<void> {
  log.info("=".repeat(60));
  log.info("Generating Short Waiting Audio Files");
  log.info("=".repeat(60));
  log.info(`Output directory: ${OUTPUT_DIR}`);
  log.info(`Total files: ${SHORT_WAITING_PHRASES.length}`);
  log.info("");

  const startTime = Date.now();
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < SHORT_WAITING_PHRASES.length; i++) {
    try {
      await generateShortWaiting(SHORT_WAITING_PHRASES[i], i);
      successCount++;
    } catch (error) {
      failCount++;
      log.error(`Failed to generate file ${i}:`, error);
    }
  }

  const duration = Date.now() - startTime;

  log.info("");
  log.info("=".repeat(60));
  log.info("Generation Complete");
  log.info("=".repeat(60));
  log.info(`Success: ${successCount}/${SHORT_WAITING_PHRASES.length}`);
  log.info(`Failed: ${failCount}`);
  log.info(`Duration: ${(duration / 1000).toFixed(2)}s`);
  log.info("");

  if (failCount > 0) {
    process.exit(1);
  }
}

// Run the script
generateAll().catch((error) => {
  log.error("Script failed:", error);
  process.exit(1);
});
