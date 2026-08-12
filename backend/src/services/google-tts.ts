/**
 * Google Cloud Text-to-Speech Service
 * 
 * Migration from Azure TTS to Google TTS
 * 
 * Benefits:
 * - Higher rate limits (default: 1000 requests/minute)
 * - Better Japanese voice quality
 * - More stable API
 * - No 429 errors on free tier
 * 
 * Setup:
 * 1. Get API key from Google Cloud Console
 * 2. Set GOOGLE_CLOUD_API_KEY in .env
 * 3. Enable Text-to-Speech API in your project
 */

import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import type { protos } from '@google-cloud/text-to-speech';
import { config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import type { EmotionType, TTSOptions } from '../types/index.js';

const log = createLogger("GoogleTTS");

// Initialize Google TTS client
let ttsClient: TextToSpeechClient | null = null;

function getClient(): TextToSpeechClient {
  if (!ttsClient) {
    // Check for service account key file (recommended for TTS)
    const keyFilePath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    
    if (keyFilePath) {
      // Use service account JSON file
      ttsClient = new TextToSpeechClient({
        keyFilename: keyFilePath,
      });
      log.debug(`Using Google service account from: ${keyFilePath}`);
    } else {
      // Fallback: try API key (less common for TTS)
      const apiKey = config.google?.cloudApiKey || config.google?.apiKey;
      if (apiKey) {
        ttsClient = new TextToSpeechClient({
          apiKey: apiKey,
        });
        log.debug('Using Google API key authentication');
      } else {
        // Last resort: default credentials (works on GCP)
        ttsClient = new TextToSpeechClient();
        log.debug('Using default Google credentials');
      }
    }
  }
  return ttsClient;
}

// Voice mapping for English
const GOOGLE_VOICES = {
  female: {
    name: config.google.ttsVoice || 'en-US-Neural2-F',
    ssmlGender: 'FEMALE' as const,
  },
  male: {
    name: 'en-US-Neural2-D',
    ssmlGender: 'MALE' as const,
  },
} as const;

// Emotion to speaking rate/pitch mapping
// Reduced pitch variations to maintain voice consistency across emotions
const EMOTION_PARAMS = {
  neutral: { speakingRate: 1.0, pitch: 0.0 },
  happy: { speakingRate: 1.02, pitch: 0.5 },
  excited: { speakingRate: 1.05, pitch: 1.0 },
  thinking: { speakingRate: 0.98, pitch: -0.5 },
  sad: { speakingRate: 0.95, pitch: -1.0 },
  surprised: { speakingRate: 1.03, pitch: 1.0 },
  confused: { speakingRate: 0.98, pitch: 0.0 },
  listening: { speakingRate: 1.0, pitch: 0.0 },
  speaking: { speakingRate: 1.0, pitch: 0.0 },
} as const;

/**
 * Synthesize speech from text using Google Cloud TTS
 * Returns audio data as Buffer (MP3 format)
 * 
 * Compatible with Azure TTS interface for easy migration
 */
export async function synthesizeSpeech(
  text: string,
  options: TTSOptions = {}
): Promise<Buffer> {
  const { voice = 'female', emotion = 'neutral', speed } = options;

  // Validate emotion
  const validEmotion: EmotionType = 
    emotion in EMOTION_PARAMS ? emotion : 'neutral';

  // Get voice configuration
  const voiceConfig = GOOGLE_VOICES[voice];
  const emotionParams = EMOTION_PARAMS[validEmotion];

  // Allow speed override
  const speakingRate = speed ?? emotionParams.speakingRate;

  // Construct the request
  const request = {
    input: { text },
    voice: {
      languageCode: 'en-US',
      name: voiceConfig.name,
      ssmlGender: voiceConfig.ssmlGender,
    },
    audioConfig: {
      audioEncoding: 'MP3' as const,
      speakingRate,
      pitch: emotionParams.pitch,
      // Optimize for quality
      sampleRateHertz: 24000,
    },
  };

  try {
    const client = getClient();
    const [response] = await client.synthesizeSpeech(request);

    if (!response.audioContent) {
      throw new Error('No audio content in response');
    }

    // Convert to Buffer
    return Buffer.from(response.audioContent as Uint8Array);
  } catch (error: any) {
    log.error('Google TTS error:', error?.message || error);
    throw new Error(`Google TTS failed: ${error?.message || 'Unknown error'}`);
  }
}

/**
 * Synthesize speech and return as base64 string
 * Used for WebSocket transmission
 */
export async function synthesizeSpeechBase64(
  text: string,
  options: TTSOptions = {}
): Promise<string> {
  const audioBuffer = await synthesizeSpeech(text, options);
  return audioBuffer.toString('base64');
}

/**
 * Get available voices
 * Useful for voice selection UI
 */
export async function listVoices(): Promise<any[]> {
  try {
    const client = getClient();
    const [response] = await client.listVoices({
      languageCode: 'en-US',
    });
    return response.voices || [];
  } catch (error) {
    log.error('Failed to list voices:', error);
    return [];
  }
}

/**
 * Test the TTS service
 */
export async function testTTS(): Promise<boolean> {
  try {
    log.info('Testing Google TTS...');
    const audio = await synthesizeSpeech('Hello', {
      voice: 'female',
      emotion: 'neutral',
    });
    log.info(`Test passed: Generated ${audio.length} bytes`);
    return true;
  } catch (error: any) {
    log.error('Test failed:', error?.message);
    return false;
  }
}
