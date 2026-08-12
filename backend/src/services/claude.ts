import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config/index.js";
import { createLogger } from "../utils/logger.js";
import { invokeLLM, invokeLLMStream } from "./claude/provider.js";
import { detectScenario, buildSystemPrompt } from "./claude/prompts.js";
import { MOVIE_KEYWORDS, GOURMET_KEYWORDS } from "../constants/keywords.js";
import type { ConversationTurn, EmotionType, MovieSearchResult, ActiveResultSet } from "../types/index.js";

const log = createLogger("Claude");

// Stop sequences for Claude
const STOP_SEQUENCES = ["That's all.", "End.", "<END>"];

// Tighter token limits for conversational style (speaker, not writer)
// 1 sentence ideal, max 2 sentences for natural spoken response
const MAX_TOKENS_DEFAULT = 100;  // ~40-50 chars, 1-2 short sentences
const MAX_TOKENS_TOOL = 180;      // Tool use needs slightly more
const MAX_TOKENS_TOOL_FOLLOWUP = 400;  // Summary of search results with numbered narration (up to 3 items)

// Tool definitions for Claude
const tools: Anthropic.Tool[] = [
  {
    name: "search_movies",
    description: "Search movies, TV shows, and anime. Use whenever you don't know a title or need fresh data. Search titles in their original spelling (no translation).",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Title, keyword, or proper noun (any language, original spelling). Exclude generic words like 'movie' or 'film' — proper nouns only." },
        genre: { type: "string", description: "Genre" },
        year: { type: "number", description: "Release year" },
      },
      required: ["query"],
    },
  },
  {
    name: "gourmet_search",
    description: "Search restaurants and dining spots by area, cuisine, or name. Search names in their original spelling (no translation).",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Restaurant name, cuisine, or keyword (any language, original spelling). Exclude generic words like 'restaurant' — proper nouns only." },
        area: { type: "string", description: "Area or neighborhood (e.g. Shinjuku, downtown)" },
        cuisine: { type: "string", description: "Cuisine type (e.g. Italian, sushi, Thai)" },
      },
      required: ["query"],
    },
  },
];

// Enhanced in-memory LRU cache for common requests (inspired by TEN Framework)
// Cache includes context from recent conversation turns for better hit rate
const CACHE_TTL_MS = 10 * 60 * 1000;  // 10 minutes for multi-turn conversations
const CACHE_LIMIT = 300;  // Increased to accommodate context-aware keys
const MAX_CACHE_KEY_LENGTH = 500;  // Limit key length to prevent excessive memory
interface CacheEntry {
  value: ChatResponse;
  timestamp: number;
  lastAccessed: number;
}
const responseCache = new Map<string, CacheEntry>();

// Common greeting patterns for instant responses (casual, friendly tone)
// NOTE: Avoid starting with short interjections (ああ, うん, えっと, わぁ, etc.)
// as frontend already plays these as waiting sounds
const INSTANT_RESPONSES: Map<RegExp, ChatResponse> = new Map([
  [/^(こんにちは|こんにちわ|hello|hi|hey)$/i, {
    text: "Hey! What's up?",
    emotion: "happy" as EmotionType,
    usedTool: false
  }],
  [/^(ありがとう|ありがとうございます|thanks|thank you)$/i, {
    text: "You're welcome! Let me know if you need anything else!",
    emotion: "happy" as EmotionType,
    usedTool: false
  }],
  [/^(さようなら|バイバイ|bye|goodbye)$/i, {
    text: "See you later! Talk anytime!",
    emotion: "happy" as EmotionType,
    usedTool: false
  }],
  [/^(はい|うん|ok|okay|yes|yeah)$/i, {
    text: "So what's going on?",
    emotion: "neutral" as EmotionType,
    usedTool: false
  }],
  [/^(おはよう|おはようございます|good morning)$/i, {
    text: "Good morning! Let's make today a good one!",
    emotion: "happy" as EmotionType,
    usedTool: false
  }],
  [/^(疲れた|つかれた|i'm tired|im tired|tired)$/i, {
    text: "You worked hard! Get some rest!",
    emotion: "sad" as EmotionType,
    usedTool: false
  }],
  [/^(暇|ひま|ヒマ|i'm bored|im bored|bored)$/i, {
    text: "Let's chat! Got anything in mind?",
    emotion: "excited" as EmotionType,
    usedTool: false
  }],
]);

/**
 * Check for instant responses (no API call needed)
 */
function getInstantResponse(message: string): ChatResponse | null {
  const trimmed = message.trim();
  for (const [pattern, response] of INSTANT_RESPONSES) {
    if (pattern.test(trimmed)) {
      return response;
    }
  }
  return null;
}

/**
 * Check if the query needs movie search tools.
 * 
 * Simple rule: if the conversation is in the movie domain, ALWAYS enable tools.
 * The LLM decides whether to actually invoke search_movies.
 * Only returns false when there's no movie context at all.
 */
export function needsMovieSearch(message: string, history?: ConversationTurn[]): boolean {
  const lowerMessage = message.toLowerCase();
  
  // 1. Explicit movie keywords — always triggers
  if (MOVIE_KEYWORDS.some(kw => lowerMessage.includes(kw.toLowerCase()))) {
    return true;
  }
  
  // 2. Domain context — if recent conversation was about movies, stay in domain
  //    No pattern matching needed; the LLM has tools + search result context
  //    and will decide whether to use them
  if (history && history.length > 0) {
    const recentTurns = history.slice(-4);
    if (recentTurns.some(turn => turn.domain === 'movie')) {
      return true;
    }
  }
  
  return false;
}

/**
 * Check if the query needs gourmet search tools.
 * 
 * Simple rule: if the conversation is in the gourmet domain, ALWAYS enable tools.
 * The LLM decides whether to actually invoke gourmet_search.
 * Only returns false when there's no gourmet context at all.
 */
export function needsGourmetSearch(message: string, history?: ConversationTurn[]): boolean {
  const lowerMessage = message.toLowerCase();
  
  // 1. Explicit gourmet keywords — always triggers
  if (GOURMET_KEYWORDS.some(kw => lowerMessage.includes(kw.toLowerCase()))) {
    return true;
  }
  
  // 2. Domain context — if recent conversation was about gourmet, stay in domain
  //    No pattern matching needed; the LLM has tools + search result context
  //    and will decide whether to use them
  if (history && history.length > 0) {
    const recentTurns = history.slice(-4);
    if (recentTurns.some(turn => turn.domain === 'gourmet')) {
      return true;
    }
  }
  
  return false;
}

/**
 * Check if the query needs any search tools (movie or gourmet)
 * Now considers conversation history for implicit detection
 */
export function needsSearch(message: string, history?: ConversationTurn[]): boolean {
  return needsMovieSearch(message, history) || needsGourmetSearch(message, history);
}

/**
 * Generate cache key for multi-turn conversations
 * Uses the last 2 turns + current message to create a context-aware key
 * This allows caching even in longer conversations when recent context is similar
 */
function getCacheKey(history: ConversationTurn[], userMessage: string): string | null {
  const normalized = userMessage.trim().toLowerCase();
  if (normalized.length < 2) return null;

  // For short/no history, use simple message-based key
  if (history.length === 0) {
    return normalized;
  }

  // For conversations with history, include last 2 turns for context
  // This allows caching similar follow-up questions across conversations
  const recentHistory = history.slice(-2);
  const contextParts: string[] = [];

  for (const turn of recentHistory) {
    // Use truncated content to keep keys manageable
    const content = turn.content.trim().toLowerCase().slice(0, 50);
    contextParts.push(`${turn.role}:${content}`);
  }

  // Combine context with current message
  const contextKey = contextParts.join("|");
  return `${contextKey}||${normalized}`;
}

function getCachedResponse(key: string | null): ChatResponse | null {
  if (!key) return null;
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  // Update last accessed time for LRU
  entry.lastAccessed = Date.now();
  return entry.value;
}

function setCachedResponse(key: string | null, value: ChatResponse): void {
  if (!key) return;

  // Skip caching if key is too long (context-aware keys can get large)
  if (key.length > MAX_CACHE_KEY_LENGTH) {
    log.debug(`Cache key too long (${key.length} chars), skipping cache`);
    return;
  }

  const now = Date.now();

  // LRU eviction: remove least recently accessed entry
  if (responseCache.size >= CACHE_LIMIT) {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;

    for (const [k, v] of responseCache.entries()) {
      if (v.lastAccessed < oldestAccess) {
        oldestAccess = v.lastAccessed;
        oldestKey = k;
      }
    }

    if (oldestKey) {
      responseCache.delete(oldestKey);
    }
  }

  responseCache.set(key, { value, timestamp: now, lastAccessed: now });
}

export interface ChatResponse {
  text: string;
  emotion: EmotionType;
  usedTool: boolean;
}

/**
 * Remove all emojis, alphabet characters, XML tags, and technical characters from text
 * TTS reads English - strip emojis and technical markup but keep letters
 */
function removeExcessiveEmojis(text: string): string {
  // Remove any [EMOTION:xxx] tags that might appear in middle of text
  text = text.replace(/\[EMOTION:\w+\]/g, '');

  // Remove XML-like tags (e.g., <_>text</_>, <tag>text</tag>, etc.)
  text = text.replace(/<[^>]*>/g, '');

  // Remove markdown-like formatting
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');  // **bold** → bold
  text = text.replace(/\*([^*]+)\*/g, '$1');      // *italic* → italic
  text = text.replace(/__([^_]+)__/g, '$1');      // __underline__ → underline
  text = text.replace(/_([^_]+)_/g, '$1');        // _italic_ → italic
  text = text.replace(/`([^`]+)`/g, '$1');        // `code` → code

  // Unicode emoji regex pattern - matches all emojis including ✨, 🐰, etc.
  const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;

  // Remove phrases that shouldn't be spoken
  const phrasesToRemove = ["search_movies tool"];
  for (const phrase of phrasesToRemove) {
    text = text.replace(phrase, '');
  }

  // Remove ALL emojis from the text
  text = text.replace(emojiRegex, '');

  // Remove any leftover brackets from emotion tags
  text = text.replace(/\[\s*:\s*\]/g, '');
  text = text.replace(/\[\s*\]/g, '');

  // Remove other technical characters that TTS can't read well
  text = text.replace(/[<>_`*#~|]/g, '');

  // Clean up extra spaces and trim
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * Trim text to the last complete sentence.
 * When max_tokens is hit, the API stops mid-sentence producing meaningless
 * cut-off text like "家族で一緒に見るのが". This trims to the last 。！？
 * so only complete sentences are sent to TTS and displayed.
 */
function trimToCompleteSentence(text: string): string {
  if (text.length === 0) return text;

  // Already ends with a sentence marker — nothing to trim
  if (/[。！？.!?]$/.test(text)) return text;

  // Find the last sentence-ending character
  const lastEnd = Math.max(
    text.lastIndexOf('。'),
    text.lastIndexOf('！'),
    text.lastIndexOf('？'),
    text.lastIndexOf('.'),
    text.lastIndexOf('!'),
    text.lastIndexOf('?'),
  );

  if (lastEnd > 0) {
    const dropped = text.slice(lastEnd + 1);
    log.debug(`Trimmed incomplete trailing text (max_tokens cut-off): "${dropped}"`);
    return text.slice(0, lastEnd + 1);
  }

  // No sentence boundary found — single incomplete sentence.
  // Return as-is (rare edge case for very short responses).
  return text;
}

/**
 * Parse emotion and text from Claude's response
 */
function parseEmotionAndText(content: string): { emotion: EmotionType; text: string } {
  const emotionMatch = content.match(/\[EMOTION:(\w+)\]/);
  const emotion = (emotionMatch?.[1] as EmotionType) || "neutral";
  let text = content.replace(/\[EMOTION:\w+\]\n?/, "").trim();
  
  // Remove excessive emojis (keep only first one)
  text = removeExcessiveEmojis(text);
  
  return { emotion, text };
}

/**
 * Convert conversation history to Claude message format
 * Limit to last 6 messages for performance
 * Filter out empty messages to avoid API errors
 */
function toClaudeMessages(history: ConversationTurn[]): Anthropic.MessageParam[] {
  const recentHistory = history.slice(-6);
  return recentHistory
    .filter((turn) => turn.content && turn.content.trim().length > 0)
    .map((turn) => ({
      role: turn.role,
      content: turn.content,
    }));
}

/**
 * Format movie results compactly
 */
function formatMovieResults(results: MovieSearchResult): string {
  if (results.movies.length === 0) {
    return JSON.stringify({ found: 0 });
  }

  const compact = results.movies.slice(0, 5).map(m => ({
    t: m.title_ja,
    y: m.release_year,
    r: m.rating,
    d: m.director,
    // g: m.genre?.slice(0, 2)
  }));

  return JSON.stringify(compact);
}

/**
 * Sentence boundary detection for streaming TTS
 */
const SENTENCE_ENDINGS = /([。！？!?.]+)/;

/**
 * Parse streaming text into complete sentences for TTS
 */
export function* extractCompleteSentences(buffer: string): Generator<{ sentence: string; remaining: string }> {
  const parts = buffer.split(SENTENCE_ENDINGS);
  
  for (let i = 0; i < parts.length - 1; i += 2) {
    const text = parts[i];
    const ending = parts[i + 1] || "";
    const sentence = text + ending;
    if (sentence.trim().length > 0) {
      yield { sentence: sentence.trim(), remaining: parts.slice(i + 2).join("") };
    }
  }
}

/**
 * Helper to process stream events and extract text with sentence boundaries
 * Note: This processes events inline to avoid SDK stream handling issues
 * 
 * OPTIMIZATION: The [EMOTION:xxx] tag is stripped before sending to frontend
 * to save bandwidth. Only clean text is sent via onChunk.
 */
interface StreamState {
  fullText: string;
  sentenceBuffer: string;
  detectedEmotion: EmotionType;
  emotionParsed: boolean;
  pendingText: string;  // Buffer for text before emotion tag is parsed
}

// Max chars to wait for emotion tag before assuming it's missing
const EMOTION_TAG_MAX_WAIT = 40;

function processStreamEvent(
  delta: string,
  state: StreamState,
  onChunk?: (text: string) => void,
  onSentence?: (sentence: string, emotion: EmotionType) => void
): void {
  state.fullText += delta;

  // Parse emotion from beginning of response
  if (!state.emotionParsed) {
    state.pendingText += delta;
    
    // Check if we have the complete emotion tag
    if (state.fullText.includes("]")) {
      const parsed = parseEmotionAndText(state.fullText);
      state.detectedEmotion = parsed.emotion;
      state.emotionParsed = true;
      state.sentenceBuffer = parsed.text;
      
      // Send the clean text (without emotion tag) to frontend
      if (onChunk && parsed.text.length > 0) {
        onChunk(removeExcessiveEmojis(parsed.text));
      }
      state.pendingText = "";
    } 
    // FALLBACK: If we've received enough text without finding emotion tag,
    // assume there's no tag and start streaming immediately
    else if (state.pendingText.length > EMOTION_TAG_MAX_WAIT || 
             !state.fullText.startsWith("[")) {
      log.debug("No emotion tag detected, using fallback (neutral)");
      state.detectedEmotion = "neutral";
      state.emotionParsed = true;
      state.sentenceBuffer = state.pendingText;
      
      // Send all buffered text to frontend
      if (onChunk && state.pendingText.length > 0) {
        onChunk(removeExcessiveEmojis(state.pendingText));
      }
      state.pendingText = "";
    }
    // Don't send anything until emotion tag is complete (saves bandwidth)
  } else {
    // Emotion already parsed - send delta directly (it's clean text)
    if (onChunk) onChunk(removeExcessiveEmojis(delta));
    state.sentenceBuffer += delta;
  }

  // Emit complete sentences for parallel TTS
  if (onSentence && state.emotionParsed) {
    for (const { sentence, remaining } of extractCompleteSentences(state.sentenceBuffer)) {
      // Filter emojis before TTS to avoid reading emoji descriptions
      const cleanSentence = removeExcessiveEmojis(sentence);
      onSentence(cleanSentence, state.detectedEmotion);
      state.sentenceBuffer = remaining;
    }
  }
}

function finalizeStream(
  state: StreamState,
  onSentence?: (sentence: string, emotion: EmotionType) => void
): { fullText: string; emotion: EmotionType } {
  // Only emit remaining buffer to TTS if it's a complete sentence.
  // When max_tokens cuts off mid-sentence, the trailing fragment
  // (e.g. "家族で一緒に見るのが") would produce meaningless TTS audio.
  const remaining = state.sentenceBuffer.trim();
  if (onSentence && remaining.length > 0) {
    if (/[。！？!?]$/.test(remaining)) {
      onSentence(removeExcessiveEmojis(remaining), state.detectedEmotion);
    } else {
      log.debug(`Dropping incomplete trailing text for TTS: "${remaining.slice(-40)}"`);
    }
  }

  const { emotion, text } = parseEmotionAndText(state.fullText);
  // Trim to last complete sentence so chat display is also clean
  const trimmedText = trimToCompleteSentence(text);
  return { fullText: trimmedText, emotion };
}

/**
 * Chat with Claude - optimized for performance
 * Now supports sentence-level streaming for parallel TTS
 *
 * @param onMovieSearch - Callback that receives search params and returns formatted results string
 * @param onGourmetSearch - Callback that receives search params and returns formatted results string
 *                          The string is passed directly to the LLM as tool result content
 */
export async function chat(
  history: ConversationTurn[],
  userMessage: string,
  onMovieSearch?: (query: string, genre?: string, year?: number) => Promise<string>,
  onChunk?: (text: string) => void,
  onSentence?: (sentence: string, emotion: EmotionType) => void,
  onToolUse?: () => void,  // Called when tool_use is detected (before DB search)
  userContext?: any,  // User context from user_profile (UserContext type)
  onGourmetSearch?: (query: string, area?: string, cuisine?: string) => Promise<string>,
  activeResults?: ActiveResultSet | null  // Current active result set for numbered selection context
): Promise<ChatResponse> {
  const messages = [
    ...toClaudeMessages(history),
    { role: "user" as const, content: userMessage },
  ];

  // Check for instant responses first (no API call, ~0ms)
  if (history.length === 0 || history.length === 1) {
    const instant = getInstantResponse(userMessage);
    if (instant) {
      log.debug("Instant response (no API call)");
      if (onChunk) onChunk(removeExcessiveEmojis(instant.text));
      if (onSentence) onSentence(removeExcessiveEmojis(instant.text), instant.emotion);
      return instant;
    }
  }

  // Detect scenario and build appropriate system prompt (with active results context)
  const scenario = detectScenario(userMessage, history);
  const systemPrompt = buildSystemPrompt(scenario, userContext, activeResults);
  
  log.debug(`Scenario detected: ${scenario}`);

  // Tools are enabled when conversation is in a domain (movie/gourmet).
  // needsSearch() returns true for: explicit keywords OR domain context in history.
  // The LLM decides whether to actually invoke search — we just make tools available.
  const useTools = needsSearch(userMessage, history);
  const cacheKey = useTools ? null : getCacheKey(history, userMessage);
  const cached = getCachedResponse(cacheKey);
  if (cached) {
    if (onChunk) onChunk(removeExcessiveEmojis(cached.text));
    if (onSentence) onSentence(removeExcessiveEmojis(cached.text), cached.emotion);
    return cached;
  }

  try {
    // Non-tool streaming path
    if (!useTools && onChunk) {
      const state: StreamState = {
        fullText: "",
        sentenceBuffer: "",
        detectedEmotion: "neutral",
        emotionParsed: false,
        pendingText: "",
      };

      // Use unified LLM streaming (supports both Anthropic and Bedrock)
      for await (const text of invokeLLMStream({
        max_tokens: MAX_TOKENS_DEFAULT,
        system: systemPrompt,
        messages,
        stop_sequences: STOP_SEQUENCES,
      })) {
        processStreamEvent(text, state, onChunk, onSentence);
      }

      const { fullText, emotion } = finalizeStream(state, onSentence);
      const result = { text: fullText, emotion, usedTool: false };
      setCachedResponse(cacheKey, result);
      return result;
    }

    // Use unified LLM invocation (supports both Anthropic and Bedrock)
    const response = await invokeLLM({
      max_tokens: useTools ? MAX_TOKENS_TOOL : MAX_TOKENS_DEFAULT,
      system: systemPrompt,
      messages,
      stop_sequences: STOP_SEQUENCES,
      tools: useTools ? tools : undefined,
    });

    if (response.stop_reason === "tool_use") {
      const toolUseBlock = response.content.find(
        (block) => block.type === "tool_use"
      );

      let searchResultContent: string | null = null;

      // Handle movie search
      if (toolUseBlock && toolUseBlock.name === "search_movies" && onMovieSearch) {
        // Notify that tool use is starting (for waiting signal)
        if (onToolUse) {
          onToolUse();
        }
        
        const input = toolUseBlock.input as { query: string; genre?: string; year?: number };
        // onMovieSearch now returns formatted string (database results only)
        searchResultContent = await onMovieSearch(input.query, input.genre, input.year);
      }
      
      // Handle gourmet search
      if (toolUseBlock && toolUseBlock.name === "gourmet_search" && onGourmetSearch) {
        // Notify that tool use is starting (for waiting signal)
        if (onToolUse) {
          onToolUse();
        }
        
        const input = toolUseBlock.input as { query: string; area?: string; cuisine?: string };
        searchResultContent = await onGourmetSearch(input.query, input.area, input.cuisine);
      }

      if (searchResultContent && toolUseBlock) {

        // Use streaming for follow-up response to enable parallel TTS
        if (onChunk || onSentence) {
          const state: StreamState = {
            fullText: "",
            sentenceBuffer: "",
            detectedEmotion: "neutral",
            emotionParsed: false,
            pendingText: "",
          };

          // Use unified LLM streaming for follow-up
          for await (const text of invokeLLMStream({
            max_tokens: MAX_TOKENS_TOOL_FOLLOWUP,
            system: systemPrompt,
            messages: [
              ...messages,
              { role: "assistant", content: response.content },
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: toolUseBlock.id,
                    content: searchResultContent,
                  },
                ],
              },
            ],
            stop_sequences: STOP_SEQUENCES,
          })) {
            processStreamEvent(text, state, onChunk, onSentence);
          }

          const { fullText, emotion } = finalizeStream(state, onSentence);
          return { text: fullText, emotion, usedTool: true };
        }

        // Non-streaming fallback
        const followUpResponse = await invokeLLM({
          max_tokens: MAX_TOKENS_TOOL_FOLLOWUP,
          system: systemPrompt,
          messages: [
            ...messages,
            { role: "assistant", content: response.content },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUseBlock.id,
                  content: searchResultContent,
                },
              ],
            },
          ],
          stop_sequences: STOP_SEQUENCES,
        });

        const textContent = followUpResponse.content
          .filter((block) => block.type === "text")
          .map((block) => block.text || "")
          .join("");

        const { emotion, text: rawText } = parseEmotionAndText(textContent);
        return { text: trimToCompleteSentence(rawText), emotion, usedTool: true };
      }
    }

    const textContent = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text || "")
      .join("");

    const { emotion, text: rawText } = parseEmotionAndText(textContent);
    const result = { text: trimToCompleteSentence(rawText), emotion, usedTool: false };
    setCachedResponse(cacheKey, result);
    return result;
  } catch (error) {
    log.error("Claude API error:", error);
    throw error;
  }
}

/**
 * Simple chat without tool use (for testing or when tools not needed)
 */
export async function simpleChat(
  history: ConversationTurn[],
  userMessage: string
): Promise<ChatResponse> {
  return chat(history, userMessage);
}
