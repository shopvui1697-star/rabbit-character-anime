import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { logger } from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from backend directory
dotenv.config({ path: join(__dirname, "../../.env") });

export const config = {
  // Server
  port: parseInt(process.env.PORT || "3001", 10),
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:3000",

  // LLM Provider Configuration
  llm: {
    provider: process.env.LLM_PROVIDER || "anthropic", // "anthropic" or "bedrock"
  },

  // AWS Services (Transcribe + Bedrock)
  aws: {
    region: process.env.AWS_REGION || "ap-northeast-1",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },

  // Anthropic Claude (direct API or compatible proxy such as 9Router)
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    model: process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-20241022",
  },

  // AWS Bedrock (Claude via Bedrock)
  bedrock: {
    region: process.env.AWS_BEDROCK_REGION || process.env.AWS_REGION || "ap-northeast-1",
    modelId: process.env.AWS_BEDROCK_MODEL_ID || "anthropic.claude-haiku-4-5-20251001-v1:0",
  },

  // PostgreSQL
  database: {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432", 10),
    database: process.env.DB_NAME || "rabbit_movies",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "postgres",
    sslMode: process.env.DB_SSLMODE || "prefer",
  },

  // Google Services (search only — TTS/STT use 9Router)
  google: {
    apiKey: process.env.GOOGLE_API_KEY || "",
    searchEngineId: process.env.GOOGLE_SEARCH_ENGINE_ID || "",
    cloudApiKey: process.env.GOOGLE_CLOUD_API_KEY || process.env.GOOGLE_API_KEY || "",
    ttsVoice: process.env.GOOGLE_TTS_VOICE || "en-US-Neural2-F",
  },

  // 9Router (TTS + STT; reuses Anthropic URL/key when dedicated vars are unset)
  ninerouter: {
    baseUrl: process.env.NINEROUTER_URL || process.env.ANTHROPIC_BASE_URL || "http://localhost:20128",
    apiKey: process.env.NINEROUTER_KEY || process.env.ANTHROPIC_API_KEY || "",
    ttsVoiceFemale: process.env.NINEROUTER_TTS_VOICE_FEMALE || "edge-tts/en-US-JennyNeural",
    ttsVoiceMale: process.env.NINEROUTER_TTS_VOICE_MALE || "edge-tts/en-US-GuyNeural",
    sttModel: process.env.NINEROUTER_STT_MODEL || "groq/whisper-large-v3-turbo",
    sttIntervalMs: parseInt(process.env.NINEROUTER_STT_INTERVAL_MS || "1200", 10),
  },

  // Direct Groq STT (bypasses 9Router when set; free tier at console.groq.com)
  groq: {
    apiKey: process.env.GROQ_API_KEY || "",
  },
} as const;

// Validate required config
export function validateConfig(): void {
  const missing: string[] = [];

  // Check LLM provider configuration
  if (config.llm.provider === "anthropic" && !config.anthropic.apiKey) {
    missing.push("ANTHROPIC_API_KEY (required for Anthropic provider)");
  }

  if (config.llm.provider === "bedrock") {
    if (!config.aws.accessKeyId || !config.aws.secretAccessKey) {
      missing.push("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (required for Bedrock provider)");
    }
  }

  if (missing.length > 0) {
    logger.warn(`Missing environment variables: ${missing.join(", ")}`);
    logger.warn("Some features may not work correctly.");
  }

  logger.info(`LLM Provider: ${config.llm.provider}`);
  if (config.llm.provider === "bedrock") {
    logger.info(`Bedrock Model: ${config.bedrock.modelId}`);
  } else {
    logger.info(`Anthropic Model: ${config.anthropic.model}`);
    if (config.anthropic.baseURL) {
      logger.info(`Anthropic Base URL: ${config.anthropic.baseURL} (9Router)`);
    }
  }

  logger.info(`9Router URL: ${config.ninerouter.baseUrl}`);
  logger.info(`9Router TTS voices: ${config.ninerouter.ttsVoiceFemale} / ${config.ninerouter.ttsVoiceMale}`);
  logger.info(`9Router STT model: ${config.ninerouter.sttModel}`);
  if (config.groq.apiKey) {
    if (config.groq.apiKey.startsWith("gsk_")) {
      logger.info("Groq STT: direct API enabled (GROQ_API_KEY set)");
    } else {
      logger.warn(
        "GROQ_API_KEY is set but does not look like a valid Groq API key (expected gsk_...). STT will fail until fixed."
      );
    }
  }
}
