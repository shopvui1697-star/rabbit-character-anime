import { config } from "../../config/index.js";

export interface NineRouterConfig {
  baseUrl: string;
  apiKey: string;
}

export interface SttEndpointConfig {
  transcriptionUrl: string;
  apiKey: string;
  model: string;
  source: "groq-direct" | "ninerouter";
}

export function getNineRouterConfig(): NineRouterConfig {
  return {
    baseUrl: config.ninerouter.baseUrl.replace(/\/$/, ""),
    apiKey: config.ninerouter.apiKey,
  };
}

export async function fetchAvailableSttModels(): Promise<string[]> {
  const { baseUrl, apiKey } = getNineRouterConfig();
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(`${baseUrl}/v1/models/stt`, { headers });
    if (!response.ok) return [];

    const payload = (await response.json()) as { data?: Array<{ id?: string }> };
    return (payload.data || [])
      .map((entry) => entry.id)
      .filter((id): id is string => Boolean(id));
  } catch {
    return [];
  }
}

export async function resolveSttEndpoint(preferredModel?: string): Promise<SttEndpointConfig> {
  const configuredModel = preferredModel || config.ninerouter.sttModel;

  if (configuredModel.startsWith("groq/") && config.groq.apiKey) {
    const groqKeyError = validateGroqApiKey(config.groq.apiKey);
    if (groqKeyError) {
      throw new Error(groqKeyError);
    }

    return {
      transcriptionUrl: "https://api.groq.com/openai/v1/audio/transcriptions",
      apiKey: config.groq.apiKey,
      model: configuredModel.slice("groq/".length),
      source: "groq-direct",
    };
  }

  const available = await fetchAvailableSttModels();
  const { baseUrl, apiKey } = getNineRouterConfig();

  if (available.length > 0) {
    const model = available.includes(configuredModel) ? configuredModel : available[0];
    return {
      transcriptionUrl: `${baseUrl}/v1/audio/transcriptions`,
      apiKey,
      model,
      source: "ninerouter",
    };
  }

  return {
    transcriptionUrl: `${baseUrl}/v1/audio/transcriptions`,
    apiKey,
    model: configuredModel,
    source: "ninerouter",
  };
}

export function validateGroqApiKey(apiKey: string): string | null {
  if (!apiKey) return null;

  if (apiKey.startsWith("org_")) {
    return (
      "GROQ_API_KEY looks like an organization ID (org_...), not an API key. " +
      "Create a key at https://console.groq.com/keys — it should start with gsk_."
    );
  }

  if (!apiKey.startsWith("gsk_")) {
    return (
      "GROQ_API_KEY has an unexpected format. Groq API keys start with gsk_. " +
      "Create one at https://console.groq.com/keys."
    );
  }

  return null;
}

export function formatSttSetupError(model: string): string {
  const groqKeyError = validateGroqApiKey(config.groq.apiKey);
  if (groqKeyError) return groqKeyError;

  const provider = model.includes("/") ? model.split("/")[0] : model;
  if (provider === "groq" || config.groq.apiKey) {
    return (
      "Groq STT authentication failed. Check GROQ_API_KEY in backend/.env " +
      "(must start with gsk_) or add Groq in 9Router dashboard."
    );
  }

  return (
    `No STT credentials configured for ${provider}. ` +
    `Add ${provider} API key in 9Router dashboard (${config.ninerouter.baseUrl}), ` +
    `or set GROQ_API_KEY in backend/.env for direct Groq STT.`
  );
}

export function isSttCredentialError(message: string): boolean {
  return /no credentials for provider|invalid api key|invalid_api_key|authentication|unauthorized/i.test(
    message
  );
}

export function nineRouterHeaders(): Record<string, string> {
  const { apiKey } = getNineRouterConfig();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

export function toIso639Language(languageCode: string): string {
  return languageCode.split("-")[0].toLowerCase();
}

/** Wrap PCM16 mono audio in a WAV container for 9Router STT uploads. */
export function pcm16ToWav(
  pcm: Buffer,
  sampleRateHertz: number,
  channels = 1,
  bitsPerSample = 16
): Buffer {
  const byteRate = sampleRateHertz * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRateHertz, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

export async function parseNineRouterError(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message || body || response.statusText;
  } catch {
    return body || response.statusText;
  }
}
