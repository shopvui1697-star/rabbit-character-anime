import { WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import { chat, needsMovieSearch, needsGourmetSearch, needsSearch } from "../services/claude.js";
import { synthesizeSpeechBase64 } from "../services/ninerouter/tts.js";
import { searchMovies } from "../db/movies.js";
import { searchGourmetRestaurants } from "../db/gourmet.js";
import { combinedMovieSearch } from "../services/combined-search.js";
import { startTimer } from "../utils/timer.js";
import { generateLongWaitingPhrase, type WaitingContext } from "../services/long-waiting.js";
import { createLogger, createUserLogger, setUserId, clearUserId } from "../utils/logger.js";
import { saveConversationTurn, getConversationHistoryByUserId, recordsToTurns } from "../db/conversation.js";
import { detectDomain } from "../utils/domain-detector.js";
import { getRandomUser, userProfileToContext, type UserContext } from "../db/user-profile.js";
import {
  NineRouterSTTSession,
  createNineRouterSTTSession,
  type NineRouterSTTConfig,
} from "../services/ninerouter/stt.js";

const log = createLogger("WS");

// Import types from shared package for new message formats
import type {
  ConversationTurn,
  ConversationStatus,
  EmotionType,
  DomainType,
  ArchiveItemInfo,
  SearchResults,
  Movie,
  GourmetRestaurant,
  WSBaseMessage,
  ActiveResultSet,
  SelectItemMessage,
  ItemFocusedMessage,
  // New message types
  ResponseMessage,
  StatusMessage as NewStatusMessage,
  AudioMessage as NewAudioMessage,
  ErrorMessage as NewErrorMessage,
  VoiceEventMessage,
  // Legacy types for backward compatibility
  WSMessage,
  LoadHistoryMessage,
  HistoryLoadedMessage,
  // Helper functions
  createResponseMessage,
  createStatusMessage,
  createAudioMessage,
  createErrorMessage,
} from "../types/index.js";

// Legacy type aliases for backward compatibility
type LegacyStatusMessage = {
  type: "status";
  status: ConversationStatus;
  emotion: EmotionType;
  statusText: string;
};
type LegacyUserMessage = { type: "user_message"; text: string };
type LegacyAssistantMessage = {
  type: "assistant_message";
  text: string;
  emotion: EmotionType;
  messageId?: string;
  responseId?: string;
  domain?: DomainType;
  archiveItem?: ArchiveItemInfo;
  searchResults?: SearchResults;
};
type LegacyErrorMessage = { type: "error"; message: string };
type LegacyLongWaitingMessage = {
  type: "long_waiting";
  audio: string;
  text: string;
  responseId?: string;
};
type SetUserInfoMessage = { type: "set_user_info"; userId?: string; userName?: string; userToken?: string };
type SaveArchiveMessage = { type: "save_archive"; userId: string; domain: DomainType; itemId: string; itemTitle?: string; itemData?: Record<string, unknown> };
type RequestGreetingMessage = { type: "request_greeting" };

import { saveToArchive, getFriendsWhoSavedItem } from "../db/user-archive.js";

// Configuration for parallel TTS streaming (TEN Framework inspired)
const ENABLE_PARALLEL_TTS = true;
const MIN_SENTENCE_LENGTH_FOR_TTS = 5;
const MAX_CONCURRENT_TTS = 6;  // Increased for better throughput (Azure handles well)
const SHORT_RESPONSE_THRESHOLD = 30;  // Skip chunking for very short responses

// Session management configuration
const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;  // 5 minutes idle timeout
const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000;  // Check every 1 minute
const MAX_MESSAGE_LENGTH = 2000;  // Maximum user message length
const MAX_REQUESTS_PER_MINUTE = 20;  // Rate limiting per session

// Waiting phrases - played before database search (pre-recorded audio)
const WAITING_PHRASES = [
  "Sure thing. Let me check on that real quick.",
  "Got it. Give me a moment.",
  "Okay, I'll look that up for you.",
  "Alright, let me dig into that.",
  "On it. I'll confirm the details for you.",
  "Leave it to me. I'll search carefully.",
  "Got it. Let me think about that for a sec.",
  "Ah, that one. Let me look it up.",
  "Right. I'll verify that right away.",
  "Sure. I'll search for that now.",
  "Yeah, I know what you mean. Let me check.",
  "Okay. I'll go find that info for you.",
  "Got it, got it. I'll take my time and look.",
  "Yeah. I'll confirm that in just a moment.",
  "Easy. I'll search for that right now.",
  "Okay. I'll do a thorough search for you.",
  "Right. Let me check the details now.",
  "Okay. I'll get that ready for you.",
  "Thanks for telling me. I'll look that up now.",
  "Understood. I'll find that for you.",
];

// Workflow step definitions matching WORKFLOW.md
type WorkflowStep = 
  | "STEP1_TEXT_INPUT"
  | "STEP2_WEBSOCKET_SEND"
  | "STEP3_BACKEND_START"
  | "STEP4_LLM_REQUEST"
  | "STEP5_DB_SEARCH"
  | "STEP6_LLM_RESPONSE"
  | "STEP7_TEXT_RESPONSE"
  | "STEP8_TTS_SYNTHESIS"
  | "STEP9_AUDIO_SEND"
  | "STEP10_AUDIO_PLAY"
  | "STEP11_TIMING_SEND"
  | "STEP12_COMPLETE";

interface StepTiming {
  step: WorkflowStep;
  name: string;
  nameJa: string;
  durationMs: number;
  startTime: number;
  endTime: number;
  details?: Record<string, unknown>;
}

interface Session {
  id: string;
  ws: WebSocket;
  history: ConversationTurn[];
  status: ConversationStatus;
  pendingRequest: boolean;
  currentResponseId: string | null;  // Track current response for barge-in cancellation
  currentAbortController: AbortController | null;  // Aborts the in-flight LLM call on barge-in
  lastActivityTime: number;  // For idle timeout cleanup
  requestCount: number;  // For rate limiting
  requestWindowStart: number;  // Rate limit window start time
  log: ReturnType<typeof createUserLogger>;  // User-specific logger
  currentDomain: DomainType;  // Current conversation domain
  userId?: string;  // User identifier (users_id from database)
  userName?: string;  // User display name (nick_name)
  userToken?: string;  // User authentication token
  userContext?: UserContext;  // Full user context for LLM
  // Active result set for numbered voice selection
  activeResults: ActiveResultSet | null;
  // Google STT streaming session
  sttSession: NineRouterSTTSession | null;
}

// Active sessions
const sessions = new Map<string, Session>();

// Session cleanup interval
let sessionCleanupInterval: NodeJS.Timeout | null = null;

/**
 * Start periodic session cleanup for idle sessions
 */
function startSessionCleanup(): void {
  if (sessionCleanupInterval) return;

  sessionCleanupInterval = setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [sessionId, session] of sessions.entries()) {
      if (now - session.lastActivityTime > SESSION_IDLE_TIMEOUT_MS) {
        log.debug(`Cleaning up idle session: ${sessionId}`);
        try {
          session.ws.close(1000, "Session idle timeout");
        } catch {
          // Ignore close errors
        }
        sessions.delete(sessionId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      log.debug(`Cleaned up ${cleanedCount} idle sessions. Active: ${sessions.size}`);
    }
  }, SESSION_CLEANUP_INTERVAL_MS);
}

/**
 * Stop session cleanup (for graceful shutdown)
 */
function stopSessionCleanup(): void {
  if (sessionCleanupInterval) {
    clearInterval(sessionCleanupInterval);
    sessionCleanupInterval = null;
  }
}

/**
 * Check rate limit for session
 * Returns true if request is allowed, false if rate limited
 */
function checkRateLimit(session: Session): boolean {
  const now = Date.now();

  // Reset window if expired (1 minute window)
  if (now - session.requestWindowStart > 60000) {
    session.requestCount = 0;
    session.requestWindowStart = now;
  }

  session.requestCount++;
  return session.requestCount <= MAX_REQUESTS_PER_MINUTE;
}

// Start cleanup on module load
startSessionCleanup();

// TTS concurrency limiter (TEN Framework pattern)
let activeTTSCount = 0;
const ttsWaitQueue: Array<() => void> = [];

async function withTTSLimit<T>(fn: () => Promise<T>): Promise<T> {
  // Wait if at concurrency limit
  if (activeTTSCount >= MAX_CONCURRENT_TTS) {
    await new Promise<void>(resolve => ttsWaitQueue.push(resolve));
  }

  activeTTSCount++;
  try {
    return await fn();
  } finally {
    activeTTSCount--;
    // Wake up next waiting request
    const next = ttsWaitQueue.shift();
    if (next) next();
  }
}

// Retry a TTS synthesis once after a transient failure before giving up.
// A single flaky 9Router call would otherwise permanently drop that sentence's
// audio chunk, stalling the frontend's chunk queue forever (it waits on chunk
// index N which never arrives).
const TTS_RETRY_DELAY_MS = 250;

async function synthesizeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (firstError) {
    log.debug("TTS attempt failed, retrying once:", firstError);
    await new Promise(resolve => setTimeout(resolve, TTS_RETRY_DELAY_MS));
    try {
      return await fn();
    } catch (retryError) {
      log.error("TTS retry also failed:", retryError);
      throw retryError;
    }
  }
}

// Step labels
const STEP_LABELS: Record<WorkflowStep, { name: string; nameJa: string }> = {
  STEP1_TEXT_INPUT: { name: "Text Input", nameJa: "テキスト入力" },
  STEP2_WEBSOCKET_SEND: { name: "WebSocket Send", nameJa: "WebSocket送信" },
  STEP3_BACKEND_START: { name: "Backend Start", nameJa: "Backend処理開始" },
  STEP4_LLM_REQUEST: { name: "LLM Request", nameJa: "LLM 呼び出し" },
  STEP5_DB_SEARCH: { name: "DB Search", nameJa: "データベース検索" },
  STEP6_LLM_RESPONSE: { name: "LLM Response", nameJa: "Claude最終レスポンス" },
  STEP7_TEXT_RESPONSE: { name: "Text Response", nameJa: "テキスト応答送信" },
  STEP8_TTS_SYNTHESIS: { name: "TTS Synthesis", nameJa: "TTS音声合成" },
  STEP9_AUDIO_SEND: { name: "Audio Send", nameJa: "音声データ送信" },
  STEP10_AUDIO_PLAY: { name: "Audio Play", nameJa: "音声再生" },
  STEP11_TIMING_SEND: { name: "Timing Send", nameJa: "タイミング情報送信" },
  STEP12_COMPLETE: { name: "Complete", nameJa: "完了" },
};

/**
 * Workflow Timer - tracks all steps in the conversation workflow
 */
class WorkflowTimer {
  private sessionId: string;
  private steps: StepTiming[] = [];
  private overallStart: number;
  private currentStepStart: number | null = null;
  private currentStep: WorkflowStep | null = null;
  private dbSearchTime: number = 0;
  private hasDbSearch: boolean = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.overallStart = performance.now();
  }

  /**
   * Start tracking a step
   */
  startStep(step: WorkflowStep, details?: Record<string, unknown>): void {
    this.currentStep = step;
    this.currentStepStart = performance.now();
  }

  /**
   * End current step
   */
  endStep(details?: Record<string, unknown>): void {
    if (this.currentStep && this.currentStepStart !== null) {
      const endTime = performance.now();
      const durationMs = Math.round(endTime - this.currentStepStart);
      const labels = STEP_LABELS[this.currentStep];

      this.steps.push({
        step: this.currentStep,
        name: labels.name,
        nameJa: labels.nameJa,
        durationMs,
        startTime: this.currentStepStart,
        endTime,
        details,
      });

      log.debug(`[${this.sessionId.slice(0, 8)}] ${this.currentStep}: ${durationMs}ms`);

      this.currentStepStart = null;
      this.currentStep = null;
    }
  }

  /**
   * Track a step with async function
   */
  async trackStep<T>(
    step: WorkflowStep,
    fn: () => Promise<T>,
    details?: Record<string, unknown>
  ): Promise<T> {
    this.startStep(step, details);
    try {
      const result = await fn();
      this.endStep(details);
      return result;
    } catch (error) {
      this.endStep({ ...details, error: true });
      throw error;
    }
  }

  /**
   * Record DB search time (tracked separately within LLM step)
   */
  recordDbSearch(durationMs: number): void {
    this.dbSearchTime = durationMs;
    this.hasDbSearch = true;
  }

  /**
   * Get summary with all steps
   */
  getSummary(): {
    sessionId: string;
    totalDurationMs: number;
    steps: StepTiming[];
    hasDbSearch: boolean;
    dbSearchTime: number;
  } {
    const totalDurationMs = Math.round(performance.now() - this.overallStart);
    return {
      sessionId: this.sessionId,
      totalDurationMs,
      steps: this.steps,
      hasDbSearch: this.hasDbSearch,
      dbSearchTime: this.dbSearchTime,
    };
  }

  /**
   * Log summary (only in debug mode)
   */
  logSummary(): void {
    const summary = this.getSummary();
    const stepDetails = this.steps.map(step => {
      const percentage = ((step.durationMs / summary.totalDurationMs) * 100).toFixed(1);
      return `${step.nameJa}: ${step.durationMs}ms (${percentage}%)`;
    }).join(", ");
    log.debug(`Workflow: ${this.sessionId.slice(0, 8)} | ${summary.totalDurationMs}ms | ${stepDetails}`);
  }
}

/**
 * Send a message to the WebSocket client
 */
function send(ws: WebSocket, message: WSMessage | WSBaseMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/**
 * Send status update to client
 * Sends both legacy and new format for backward compatibility
 */
function sendStatus(
  ws: WebSocket,
  status: ConversationStatus,
  emotion: EmotionType,
  statusText: string
): void {
  // Legacy format (for existing frontend)
  const legacyMessage: LegacyStatusMessage = {
    type: "status",
    status,
    emotion,
    statusText,
  };
  send(ws, legacyMessage);
  
  // New format will be enabled in future when frontend is ready
  // const newMessage = createStatusMessage(emotion, status, statusText);
  // send(ws, newMessage);
}

/**
 * Send user message echo to client
 */
function sendUserMessage(ws: WebSocket, text: string): void {
  const message: LegacyUserMessage = {
    type: "user_message",
    text,
  };
  send(ws, message);
}

/**
 * Send assistant message to client
 * Sends both legacy and new format for backward compatibility
 */
function sendAssistantMessage(
  ws: WebSocket,
  text: string,
  emotion: EmotionType,
  messageId?: string,
  domain?: DomainType,
  archiveItem?: ArchiveItemInfo,
  searchResults?: SearchResults,
  sentenceSync?: boolean,
  responseId?: string
): void {
  // Legacy format (for existing frontend)
  const legacyMessage: LegacyAssistantMessage = {
    type: "assistant_message",
    text,
    emotion,
    ...(messageId ? { messageId } : {}),
    ...(responseId ? { responseId } : {}),
    ...(domain ? { domain } : {}),
    ...(archiveItem ? { archiveItem } : {}),
    ...(searchResults ? { searchResults } : {}),
    ...(sentenceSync ? { sentenceSync: true } : {}),
  };
  send(ws, legacyMessage);
  
  // New format will be enabled in future when frontend is ready
  // Build component data if search results exist
  // let component: ResponseMessage["component"] = undefined;
  // if (searchResults) {
  //   if (searchResults.type === "movie" && searchResults.movies) {
  //     component = {
  //       type: "movie_list",
  //       data: { movies: searchResults.movies, total: searchResults.total },
  //     };
  //   } else if (searchResults.type === "gourmet" && searchResults.restaurants) {
  //     component = {
  //       type: "gourmet_list",
  //       data: { restaurants: searchResults.restaurants, total: searchResults.total },
  //     };
  //   }
  // }
  // const newMessage = createResponseMessage(emotion, "speaking", text, messageId || "", false, {
  //   component,
  //   context: domain ? { domain } : undefined,
  //   extra: archiveItem ? { archiveItem } : undefined,
  // });
  // send(ws, newMessage);
}

/**
 * Send assistant streaming delta
 * Sends both legacy and new format for backward compatibility
 */
function sendAssistantDelta(ws: WebSocket, text: string, messageId: string): void {
  // Legacy format
  send(ws, {
    type: "assistant_delta",
    text,
    messageId,
  });
  
  // New format will be enabled in future when frontend is ready
  // const newMessage = createResponseMessage("thinking", "thinking", text, messageId, true);
  // send(ws, newMessage);
}

/**
 * Send error message to client
 * Sends both legacy and new format for backward compatibility
 */
function sendError(ws: WebSocket, errorMessage: string): void {
  // Legacy format
  const legacyMessage: LegacyErrorMessage = {
    type: "error",
    message: errorMessage,
  };
  send(ws, legacyMessage);
  
  // New format will be enabled in future when frontend is ready
  // const newMessage = createErrorMessage("UNKNOWN_ERROR", errorMessage, true);
  // send(ws, newMessage);
}

/**
 * Send long waiting audio (for database operations)
 * Sends both legacy and new format for backward compatibility
 */
async function sendLongWaiting(
  ws: WebSocket,
  context: WaitingContext,
  responseId: string
): Promise<void> {
  try {
    // Generate contextual waiting phrase
    const text = generateLongWaitingPhrase(context);
    log.debug(`Sending long waiting phrase: "${text}"`);

    // Synthesize speech immediately
    // Use "speaking" emotion to match conversational flow
    const audio = await synthesizeSpeechBase64(text, {
      emotion: "speaking",
      voice: "female",
    });
    
    // Legacy format (for existing frontend)
    const legacyMessage: LegacyLongWaitingMessage = {
      type: "long_waiting",
      audio,
      text,
      responseId,
    };
    send(ws, legacyMessage);
    
    // New format will be enabled in future when frontend is ready
    // const newMessage = createAudioMessage(audio, "mp3", {
    //   isProtected: true,  // Cannot be interrupted
    //   text,
    //   responseId,
    // });
    // send(ws, newMessage);
  } catch (error) {
    log.error("Failed to generate long waiting audio:", error);
  }
}

/**
 * Send transcript message to client (real-time STT)
 */
/**
 * Send waiting signal to client (before DB search)
 * Frontend plays pre-recorded audio from public/waiting/{index}.mp3
 * 
 * DISABLED: Moved to frontend with configurable delay (NEXT_PUBLIC_WAITING_DELAY)
 * Frontend now automatically plays random waiting audio after submitting message
 */
// function sendWaiting(ws: WebSocket): void {
//   const index = Math.floor(Math.random() * WAITING_PHRASES.length);
//   console.log(`⏳ Sending waiting signal #${index}: "${WAITING_PHRASES[index]}"`);
//   send(ws, {
//     type: "waiting",
//     index,
//     text: WAITING_PHRASES[index],  // For debugging/fallback
//   });
// }

/**
 * Send workflow timing information to client
 */
function sendWorkflowTiming(
  ws: WebSocket,
  workflowTimer: WorkflowTimer,
  usedTool: boolean = false
): void {
  const summary = workflowTimer.getSummary();
  
  send(ws, {
    type: "workflow_timing",
    steps: summary.steps.map((s) => ({
      step: s.step,
      name: s.name,
      nameJa: s.nameJa,
      durationMs: s.durationMs,
    })),
    hasDbSearch: summary.hasDbSearch,
    dbSearchTime: summary.dbSearchTime,
    usedTool,
    totalMs: summary.totalDurationMs,
  });
}

// ============================================================================
// Numbered Selection: Number extraction from user text
// ============================================================================

const KANJI_TO_NUMBER: Record<string, number> = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9,
  '１': 1, '２': 2, '３': 3, '４': 4, '５': 5,
  '６': 6, '７': 7, '８': 8, '９': 9,
};

const HIRAGANA_TO_NUMBER: Record<string, number> = {
  'いち': 1, 'に': 2, 'さん': 3, 'よん': 4, 'ご': 5,
};

const ENGLISH_ORDINAL_TO_NUMBER: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
};

/**
 * Extract a 1-based selection number from user text
 * Handles: number 2, #2, second, 1番, 10番, 一番, いちばん, etc.
 */
function extractSelectionNumber(text: string): number | null {
  const patterns: Array<{ pattern: RegExp; extract: (m: RegExpMatchArray) => number | null }> = [
    { pattern: /(?:number|#|item)\s*([1-9]\d*)/i, extract: m => parseInt(m[1]) },
    { pattern: /\b(first|second|third|fourth|fifth)\b/i, extract: m => ENGLISH_ORDINAL_TO_NUMBER[m[1].toLowerCase()] ?? null },
    { pattern: /([1-9]\d*)番/, extract: m => parseInt(m[1]) },
    { pattern: /([１-９])番/, extract: m => KANJI_TO_NUMBER[m[1]] ?? null },
    { pattern: /([一二三四五六七八九])番/, extract: m => KANJI_TO_NUMBER[m[1]] ?? null },
    { pattern: /([1-9]\d*)つ目/, extract: m => parseInt(m[1]) },
    { pattern: /([一二三四五])つ目/, extract: m => KANJI_TO_NUMBER[m[1]] ?? null },
    { pattern: /(いち|に|さん|よん|ご)ばん/, extract: m => HIRAGANA_TO_NUMBER[m[1]] ?? null },
  ];

  for (const { pattern, extract } of patterns) {
    const match = text.match(pattern);
    if (match) {
      const num = extract(match);
      if (num !== null && num >= 1) return num;
    }
  }
  return null;
}

/**
 * Get the display name of a search result item
 */
function getItemName(item: Movie | GourmetRestaurant, type: "movie" | "gourmet"): string {
  if (type === "movie") {
    return (item as Movie).title_ja;
  }
  return (item as GourmetRestaurant).name;
}

/**
 * Get the item ID for a search result item
 */
function getItemId(item: Movie | GourmetRestaurant, type: "movie" | "gourmet"): string {
  if (type === "movie") {
    return (item as Movie).id?.toString() || `movie-${Date.now()}`;
  }
  return (item as GourmetRestaurant).id?.toString() || `gourmet-${Date.now()}`;
}

// Active results expiry: 10 minutes
const ACTIVE_RESULTS_EXPIRY_MS = 10 * 60 * 1000;

/**
 * Format gourmet search results for LLM
 */
function formatGourmetResults(result: import("../types/index.js").GourmetSearchResult): string {
  if (result.restaurants.length === 0) {
    return JSON.stringify({ found: 0 });
  }

  const compact = result.restaurants.slice(0, 5).map(r => ({
    name: r.name,
    addr: r.address,
    copy: r.catch_copy,
    access: r.access,
    hours: r.open_hours,
  }));

  // Log formatted results being sent to LLM
  const names = result.restaurants.slice(0, 3).map(r => r.name).join(", ");
  const more = result.restaurants.length > 3 ? ` +${result.restaurants.length - 3} more` : "";
  createLogger("Gourmet").debug(`📤 Formatted ${result.restaurants.length} results for LLM: ${names}${more}`);

  return JSON.stringify(compact);
}

/**
 * Process user text input and generate response
 */
async function processUserInput(session: Session, userText: string): Promise<void> {
  const { ws, history, log: sessionLog } = session;
  
  // Log user input to session file with user context
  if (session.userContext) {
    console.log(`💬 [User ${session.userContext.userId}] ${session.userContext.nickName}: "${userText.substring(0, 50)}${userText.length > 50 ? '...' : ''}"`);
    
    sessionLog.info(`👤 User: ${session.userContext.nickName} (ID: ${session.userContext.userId})`);
    sessionLog.info(`💬 Message: "${userText}"`);
    if (session.userContext.interests && session.userContext.interests.length > 0) {
      sessionLog.debug(`🎯 User Interests: ${session.userContext.interests.join(', ')}`);
    }
    if (session.userContext.age) {
      sessionLog.debug(`👶 User Age: ${session.userContext.age}歳`);
    }
    if (session.userContext.province) {
      sessionLog.debug(`📍 User Location: ${session.userContext.province}`);
    }
  } else {
    console.log(`💬 [Guest] "${userText.substring(0, 50)}${userText.length > 50 ? '...' : ''}"`);
    sessionLog.info(`User input: "${userText}" (no user context)`);
  }
  
  // Generate unique response ID for this request (for barge-in cancellation)
  const responseId = `${session.id}-${Date.now()}`;
  
  // Cancel any previous response by setting new responseId
  // This will cause ongoing audio chunk sends to be skipped
  if (session.currentResponseId) {
    sessionLog.debug("Cancelling previous response (barge-in)");
  }
  session.currentResponseId = responseId;

  // Actually abort the previous in-flight LLM call (not just skip delivery) —
  // saves tokens/latency on barge-in instead of letting the old request run to completion.
  session.currentAbortController?.abort();
  const abortController = new AbortController();
  session.currentAbortController = abortController;

  // Reset pendingRequest flag (allow new request to override)
  session.pendingRequest = true;
  
  const workflow = new WorkflowTimer(session.id);

  try {
    // STEP 1 & 2: Already happened on client side, we mark as received
    workflow.startStep("STEP2_WEBSOCKET_SEND");
    workflow.endStep({ received: true });

    // STEP 3: Backend processing start
    workflow.startStep("STEP3_BACKEND_START");
    sendUserMessage(ws, userText);
    session.status = "thinking";
    sendStatus(ws, "thinking", "thinking", "Thinking...");
    sessionLog.debug("Backend processing started");
    workflow.endStep();

    // ================================================================
    // NUMBERED SELECTION: Check if user is selecting by number
    // If "2番" is detected and we have active results, resolve the entity
    // and inject context so the LLM knows which item the user means
    // ================================================================
    let enrichedUserText = userText;
    const selectionNumber = extractSelectionNumber(userText);
    
    if (selectionNumber && session.activeResults && session.activeResults.items.length > 0) {
      // Check if results haven't expired
      if (Date.now() - session.activeResults.timestamp < ACTIVE_RESULTS_EXPIRY_MS) {
        const index = selectionNumber - 1;
        if (index < session.activeResults.items.length) {
          const selectedItem = session.activeResults.items[index];
          session.activeResults.selectedIndex = index;
          
          const entityName = getItemName(selectedItem, session.activeResults.type);
          
          // Inject resolved entity context into the user message for LLM
          enrichedUserText = `[User selected "${entityName}"] ${userText}`;
          sessionLog.info(`🔢 Number selection: ${selectionNumber}番 → "${entityName}" (index: ${index})`);
          
          // Send item_focused to frontend so the card gets highlighted
          const focusedMsg: ItemFocusedMessage = {
            type: "item_focused",
            index,
            itemId: getItemId(selectedItem, session.activeResults.type),
            domain: session.activeResults.type,
            itemTitle: entityName,
            action: "highlight",
          };
          send(ws, focusedMsg);
        } else {
          sessionLog.debug(`🔢 Selection ${selectionNumber} out of range (${session.activeResults.items.length} items)`);
        }
      } else {
        sessionLog.debug("🔢 Active results expired, ignoring number selection");
        session.activeResults = null;
      }
    }

    // STEP 4-6: LLM Request and Response
    workflow.startStep("STEP4_LLM_REQUEST");

    const assistantMessageId = `assistant-${session.id}-${Date.now()}`;

    // Track found movies/gourmet for archive
    let foundArchiveItem: ArchiveItemInfo | undefined = undefined;
    
    // Track all search results for frontend display
    let allSearchResults: import("../types/index.js").SearchResults | undefined = undefined;

    // Prefetch database movie search in parallel when likely needed
    // Pass history for implicit detection (e.g., follow-up questions like "それについて教えて")
    const shouldPrefetchMovies = needsMovieSearch(userText, history);
    const shouldPrefetchGourmet = needsGourmetSearch(userText, history);
    
    const prefetchMoviePromise = shouldPrefetchMovies
      ? (async () => {
          const prefetchTimer = startTimer("Database Search (Prefetch)", { query: userText });
          const result = await combinedMovieSearch(userText);
          const timing = prefetchTimer.stop();
          workflow.recordDbSearch(timing.durationMs);
          
          // Extract first movie for archive if found
          if (result.dbResults && result.dbResults.movies && result.dbResults.movies.length > 0) {
            const movie = result.dbResults.movies[0];
            foundArchiveItem = {
              itemId: movie.id?.toString() || `movie-${Date.now()}`,
              itemTitle: movie.title_ja,
              itemDomain: "movie" as DomainType,
              itemData: {
                title_en: movie.title_en,
                description: movie.description,
                release_year: movie.release_year,
                rating: movie.rating,
                director: movie.director,
                actors: movie.actors,
              },
            };
            
            // Store all search results for frontend
            allSearchResults = {
              type: "movie",
              movies: result.dbResults.movies,
              total: result.dbResults.total,
            };
            
            // Populate active results for numbered selection
            session.activeResults = {
              type: "movie",
              items: result.dbResults.movies,
              selectedIndex: null,
              query: userText,
              timestamp: Date.now(),
            };
            sessionLog.debug(`🔢 Active results set: ${result.dbResults.movies.length} movies`);
          }
          
          return result.merged; // Return formatted string for LLM
        })().catch(() => null)
      : null;

    const prefetchGourmetPromise = shouldPrefetchGourmet
      ? (async () => {
          const prefetchTimer = startTimer("Gourmet Search (Prefetch)", { query: userText });
          const result = await searchGourmetRestaurants(userText);
          const timing = prefetchTimer.stop();
          workflow.recordDbSearch(timing.durationMs);
          
          // Extract first restaurant for archive if found
          if (result.restaurants && result.restaurants.length > 0) {
            const restaurant = result.restaurants[0];
            foundArchiveItem = {
              itemId: restaurant.id?.toString() || `gourmet-${Date.now()}`,
              itemTitle: restaurant.name,
              itemDomain: "gourmet" as DomainType,
              itemData: {
                code: restaurant.code,
                address: restaurant.address,
                catch_copy: restaurant.catch_copy,
                urls_pc: restaurant.urls_pc,
                open_hours: restaurant.open_hours,
              },
            };
            
            // Store all search results for frontend
            allSearchResults = {
              type: "gourmet",
              restaurants: result.restaurants,
              total: result.total,
            };
            
            // Populate active results for numbered selection
            session.activeResults = {
              type: "gourmet",
              items: result.restaurants,
              selectedIndex: null,
              query: userText,
              timestamp: Date.now(),
            };
            sessionLog.debug(`🔢 Active results set: ${result.restaurants.length} gourmet restaurants`);
          }
          
          // Format results for LLM
          return formatGourmetResults(result);
        })().catch(() => null)
      : null;

    // Parallel TTS: Queue sentences and synthesize while LLM is still streaming
    interface TTSChunkResult {
      audio: string;
      sentence: string;
      index: number;
      durationMs: number;
      charCount: number;
    }
    const ttsQueue: Promise<TTSChunkResult | null>[] = [];
    let sentenceIndex = 0;

    // Log if user context is being used
    if (session.userContext) {
      sessionLog.debug(`🎯 Using user context for personalized response (${session.userContext.nickName})`);
    }

    const response = await chat(
      history,
      enrichedUserText,
      async (query, genre, year) => {
        // Skip if response was cancelled (barge-in)
        if (session.currentResponseId !== responseId) {
          return ""; // Return empty to abort gracefully
        }

        // DISABLED: Long waiting audio for database operations
        // User requested to turn off long-waiting when accessing database
        // await sendLongWaiting(ws, {
        //   query: query || undefined,
        //   genre: genre || undefined,
        //   year: year || undefined,
        // }, responseId);

        // Track database search within LLM step
        if (
          prefetchMoviePromise &&
          query.trim() === userText.trim() &&
          !genre &&
          !year
        ) {
          const prefetched = await prefetchMoviePromise;
          if (prefetched) {
            return prefetched;
          }
        }

        const searchTimer = startTimer("Combined Search", { query, genre, year });
        const result = await combinedMovieSearch(query, genre, year);
        const searchTiming = searchTimer.stop();
        workflow.recordDbSearch(searchTiming.durationMs);
        
        // Extract first movie for archive and update results
        // Always update when tool_use search completes - it reflects Claude's refined query
        // and should take precedence over prefetch results
        if (result.dbResults && result.dbResults.movies && result.dbResults.movies.length > 0) {
          const movie = result.dbResults.movies[0];
          foundArchiveItem = {
            itemId: movie.id?.toString() || `movie-${Date.now()}`,
            itemTitle: movie.title_ja,
            itemDomain: "movie" as DomainType,
            itemData: {
              title_en: movie.title_en,
              description: movie.description,
              release_year: movie.release_year,
              rating: movie.rating,
              director: movie.director,
              actors: movie.actors,
            },
          };
          
          // Store all search results for frontend (override prefetch results)
          allSearchResults = {
            type: "movie",
            movies: result.dbResults.movies,
            total: result.dbResults.total,
          };
          
          // Populate active results for numbered selection
          session.activeResults = {
            type: "movie",
            items: result.dbResults.movies,
            selectedIndex: null,
            query: query,
            timestamp: Date.now(),
          };
          sessionLog.debug(`🔢 Active results updated by tool_use: ${result.dbResults.movies.length} movies (query: "${query}")`);
        }
        
        return result.merged; // Return formatted string for LLM
      },
      (delta) => {
        // Skip if response was cancelled (barge-in)
        if (session.currentResponseId !== responseId) return;
        // When parallel TTS is enabled, text is sent with audio_chunk (sentence sync)
        // Only stream deltas when parallel TTS is disabled
        if (!ENABLE_PARALLEL_TTS) {
          sendAssistantDelta(ws, delta, assistantMessageId);
        }
      },
      ENABLE_PARALLEL_TTS ? (sentence, emotion) => {
        // Skip if response was cancelled (barge-in)
        if (session.currentResponseId !== responseId) return;
        
        // Parallel TTS: Start synthesizing each sentence immediately
        if (sentence.length >= MIN_SENTENCE_LENGTH_FOR_TTS) {
          const idx = sentenceIndex++;
          const startTime = performance.now();
          const charCount = sentence.length;
          
          log.debug(`[${session.id.slice(0, 8)}] TTS #${idx} START: "${sentence.slice(0, 30)}..." (${charCount} chars)`);
          sessionLog.debug(`TTS chunk #${idx} BEGIN: ${charCount} chars, emotion: ${emotion}, text: "${sentence.slice(0, 50)}..."`);

          // Use TTS concurrency limiter to avoid rate limiting, and retry once
          // on transient failure so a single flaky call doesn't permanently
          // drop this chunk (which would stall the frontend's ordered queue).
          const ttsPromise = withTTSLimit(() =>
            synthesizeWithRetry(() =>
              synthesizeSpeechBase64(sentence, {
                emotion,
                voice: "female",
              })
            )
          ).then(audio => {
            const durationMs = Math.round(performance.now() - startTime);
            const audioKB = Math.round(audio.length * 0.75 / 1024);
            log.debug(`[${session.id.slice(0, 8)}] TTS #${idx} DONE: ${durationMs}ms`);
            sessionLog.debug(`TTS chunk #${idx} END: ${durationMs}ms, ${audioKB}KB`);
            return { audio, sentence, index: idx, durationMs, charCount };
          }).catch(err => {
            const durationMs = Math.round(performance.now() - startTime);
            log.error(`[${session.id.slice(0, 8)}] TTS #${idx} FAILED after ${durationMs}ms:`, err);
            sessionLog.error(`TTS chunk #${idx} FAILED: ${durationMs}ms`, err);
            return null;
          });
          
          ttsQueue.push(ttsPromise);
        }
      } : undefined,
      // onToolUse callback - DISABLED (moved to frontend with configurable delay)
      // Frontend now plays waiting audio automatically after NEXT_PUBLIC_WAITING_DELAY ms
      // () => {
      //   // Skip if response was cancelled (barge-in)
      //   if (session.currentResponseId !== responseId) return;
      //   sendWaiting(ws);
      // }
      undefined,
      session.userContext,  // Pass user context to LLM for personalized responses
      async (query, area, cuisine) => {
        // Skip if response was cancelled (barge-in)
        if (session.currentResponseId !== responseId) {
          return ""; // Return empty to abort gracefully
        }

        // Track gourmet search within LLM step
        if (
          prefetchGourmetPromise &&
          query.trim() === userText.trim() &&
          !area &&
          !cuisine
        ) {
          const prefetched = await prefetchGourmetPromise;
          if (prefetched) {
            return prefetched;
          }
        }

        const searchTimer = startTimer("Gourmet Search", { query, area, cuisine });
        const result = await searchGourmetRestaurants(query, area, cuisine);
        const searchTiming = searchTimer.stop();
        workflow.recordDbSearch(searchTiming.durationMs);
        
        // Extract first restaurant for archive and update results
        // Always update when tool_use search completes - it reflects Claude's refined query
        // and should take precedence over prefetch results
        if (result.restaurants && result.restaurants.length > 0) {
          const restaurant = result.restaurants[0];
          foundArchiveItem = {
            itemId: restaurant.id?.toString() || `gourmet-${Date.now()}`,
            itemTitle: restaurant.name,
            itemDomain: "gourmet" as DomainType,
            itemData: {
              code: restaurant.code,
              address: restaurant.address,
              catch_copy: restaurant.catch_copy,
              urls_pc: restaurant.urls_pc,
              open_hours: restaurant.open_hours,
            },
          };
          
          // Store all search results for frontend (override prefetch results)
          allSearchResults = {
            type: "gourmet",
            restaurants: result.restaurants,
            total: result.total,
          };
          
          // Populate active results for numbered selection
          session.activeResults = {
            type: "gourmet",
            items: result.restaurants,
            selectedIndex: null,
            query: query,
            timestamp: Date.now(),
          };
          sessionLog.debug(`🔢 Active results updated by tool_use: ${result.restaurants.length} restaurants (query: "${query}")`);
        }
        
        return formatGourmetResults(result); // Return formatted string for LLM
      },
      session.activeResults,  // Pass active results for numbered selection context
      abortController.signal  // Abort the LLM call itself when superseded by barge-in
    );

    workflow.endStep({
      inputLength: userText.length,
      usedTool: response.usedTool,
      hasToolUse: workflow.getSummary().hasDbSearch
    });

    // Determine which tool was used
    let toolUsed = "none";
    if (response.usedTool) {
      if (shouldPrefetchMovies) {
        toolUsed = "movie search";
      } else if (shouldPrefetchGourmet) {
        toolUsed = "gourmet search";
      } else {
        toolUsed = "search";
      }
    }
    
    sessionLog.debug(`Tool used: ${toolUsed}`);
    sessionLog.info(`Assistant response: "${response.text}" [emotion: ${response.emotion}]`);

    // Check if response was cancelled (barge-in) before proceeding
    if (session.currentResponseId !== responseId) {
      sessionLog.debug("Response cancelled, skipping delivery");
      return;
    }

    // Detect domain from user message
    const domain = detectDomain(userText);
    session.currentDomain = domain;
    sessionLog.debug(`Detected domain: ${domain}`);

    // Update conversation history (in-memory)
    const userTurn: ConversationTurn = { role: "user", content: userText, domain };
    const assistantTurn: ConversationTurn = { 
      role: "assistant", 
      content: response.text, 
      domain,
      emotion: response.emotion 
    };
    
    history.push(userTurn);
    history.push(assistantTurn);

    // Save to database (async, don't block)
    saveConversationTurn(
      session.id, 
      userTurn, 
      domain, 
      session.userId, 
      session.userName, 
      session.userToken
    ).catch(err => {
      sessionLog.error("Failed to save user turn to database:", err);
    });
    saveConversationTurn(
      session.id, 
      assistantTurn, 
      domain, 
      session.userId, 
      session.userName, 
      session.userToken
    ).catch(err => {
      sessionLog.error("Failed to save assistant turn to database:", err);
    });

    // Limit history to last 20 turns
    if (history.length > 20) {
      history.splice(0, history.length - 20);
    }

    // STEP 7: Send text response (with archive item info and all search results if found)
    // When parallel TTS has chunks, enable sentenceSync so frontend reveals text
    // sentence-by-sentence in sync with audio playback
    const hasSentenceSync = ENABLE_PARALLEL_TTS && ttsQueue.length > 0 && 
                            response.text.length >= SHORT_RESPONSE_THRESHOLD;
    workflow.startStep("STEP7_TEXT_RESPONSE");
    sendAssistantMessage(ws, response.text, response.emotion, assistantMessageId, domain, foundArchiveItem, allSearchResults, hasSentenceSync, responseId);
    session.status = "speaking";
    sendStatus(ws, "speaking", response.emotion, "Speaking...");
    workflow.endStep({ textLength: response.text.length, emotion: response.emotion, sentenceSync: hasSentenceSync });

    // STEP 8: TTS synthesis (parallel mode or fallback)
    workflow.startStep("STEP8_TTS_SYNTHESIS");
    
    let audioSent = false;
    
    // Short response optimization: skip chunking for very brief responses
    const useParallelTTS = ENABLE_PARALLEL_TTS && 
                           ttsQueue.length > 0 && 
                           response.text.length >= SHORT_RESPONSE_THRESHOLD;
    
    if (useParallelTTS) {
      // Process TTS chunks - send immediately as each completes (true parallel)
      const ttsOverallStart = performance.now();
      sessionLog.info(`TTS parallel mode BEGIN: ${ttsQueue.length} chunks, ${response.text.length} chars`);
      log.debug(`[${session.id.slice(0, 8)}] Sending ${ttsQueue.length} TTS chunks...`);

      const totalChunks = ttsQueue.length;
      const chunkResults: TTSChunkResult[] = [];
      let sentCount = 0;

      // Process all chunks in parallel and send each as it completes
      const sendPromises = ttsQueue.map(async (promise, i) => {
        const result = await promise;

        // Check if this response is still current (not cancelled by barge-in)
        if (session.currentResponseId !== responseId) {
          log.debug(`[${session.id.slice(0, 8)}] Skipping chunk #${i} (cancelled)`);
          return null;
        }

        if (result) {
          // Send immediately when this chunk is ready (don't wait for earlier chunks)
          // Include sentence text for synchronized text+audio display
          send(ws, {
            type: "audio_chunk",
            data: result.audio,
            format: "mp3",
            index: result.index,
            total: totalChunks,
            isLast: result.index === totalChunks - 1,
            responseId,  // Include responseId so frontend can ignore stale chunks
            sentence: result.sentence,  // Sentence text for sync display
          });
          sentCount++;
          chunkResults.push(result);
          return result;
        }

        // Synthesis failed even after retry. Still send a message for this index
        // (with no audio) so the frontend's ordered chunk queue doesn't wait
        // forever on an index that will never arrive — it can skip straight
        // to the next chunk instead of stalling playback.
        log.debug(`[${session.id.slice(0, 8)}] Sending failed marker for chunk #${i}`);
        send(ws, {
          type: "audio_chunk",
          data: "",
          format: "mp3",
          index: i,
          total: totalChunks,
          isLast: i === totalChunks - 1,
          responseId,
          failed: true,
        });
        return null;
      });
      
      // Wait for all to complete (but they've already been sent as they finished)
      await Promise.all(sendPromises);
      audioSent = sentCount > 0;
      
      const ttsOverallDuration = Math.round(performance.now() - ttsOverallStart);
      
      // Calculate totals for logging
      const totalTTSTime = chunkResults.reduce((sum, c) => sum + c.durationMs, 0);
      const totalChars = chunkResults.reduce((sum, c) => sum + c.charCount, 0);
      const totalAudioKB = chunkResults.reduce((sum, c) => sum + Math.round(c.audio.length * 0.75 / 1024), 0);
      
      // Log TTS summary
      chunkResults.sort((a, b) => a.index - b.index);
      log.debug(`[${session.id.slice(0, 8)}] TTS complete: ${chunkResults.length} chunks, ${totalTTSTime}ms, ${totalAudioKB}KB`);
      sessionLog.info(`TTS parallel mode END: ${chunkResults.length} chunks, wall time ${ttsOverallDuration}ms, total TTS time ${totalTTSTime}ms, ${totalAudioKB}KB`);

      workflow.endStep({ 
        mode: "parallel", 
        chunks: totalChunks,
        totalTTSTime,
        textLength: response.text.length 
      });
    }
    
    // Fallback: synthesize full response if parallel TTS didn't produce audio
    if (!audioSent) {
      // Check if response was cancelled before starting sequential TTS
      if (session.currentResponseId !== responseId) {
        log.debug(`[${session.id.slice(0, 8)}] Skipping sequential TTS (cancelled)`);
        workflow.endStep({ mode: "cancelled" });
      } else if (!response.text.trim()) {
        // Empty LLM reply — skip TTS to avoid 9Router "Missing required field: input"
        log.debug(`[${session.id.slice(0, 8)}] Skipping sequential TTS (empty text)`);
        sessionLog.info("TTS skipped: empty assistant response");
        workflow.endStep({ mode: "skipped", reason: "empty_text" });
      } else {
        log.debug(`[${session.id.slice(0, 8)}] Sequential TTS (fallback)`);
        const seqStartTime = performance.now();
        sessionLog.info(`TTS sequential mode BEGIN: ${response.text.length} chars, emotion: ${response.emotion}`);
        
        try {
          const audioBase64 = await synthesizeSpeechBase64(response.text, {
            emotion: response.emotion,
            voice: "female",
          });
          
          // Check again after TTS completes (could be cancelled during synthesis)
          if (session.currentResponseId !== responseId) {
            log.debug(`[${session.id.slice(0, 8)}] Skipping audio send (cancelled)`);
            sessionLog.info("TTS sequential mode CANCELLED");
            workflow.endStep({ mode: "cancelled" });
          } else {
            const seqDuration = Math.round(performance.now() - seqStartTime);
            const audioKB = Math.round(audioBase64.length * 0.75 / 1024);
            log.debug(`[${session.id.slice(0, 8)}] TTS sequential: ${seqDuration}ms, ${audioKB}KB`);
            sessionLog.info(`TTS sequential mode END: ${seqDuration}ms, ${audioKB}KB`);

            workflow.endStep({ 
              mode: "sequential",
              textLength: response.text.length, 
              durationMs: seqDuration,
              emotion: response.emotion 
            });

            // STEP 9: Send audio data with responseId for tracking
            // Include sentence text for sequential TTS sync display
            workflow.startStep("STEP9_AUDIO_SEND");
            send(ws, {
              type: "audio",
              data: audioBase64,
              format: "mp3",
              responseId,  // Add responseId to full audio messages too
              sentence: response.text,  // Full text for sync display
            });
            workflow.endStep({ audioSize: audioBase64.length });
            audioSent = true;
          }
        } catch (ttsError) {
          log.error("TTS error:", ttsError);
          sessionLog.error("TTS sequential mode ERROR", ttsError);
          workflow.endStep({ error: true });
          send(ws, {
            type: "tts_error",
            message: "Failed to generate audio",
          });
        }
      }
    } else {
      // Mark audio send complete for parallel mode
      workflow.startStep("STEP9_AUDIO_SEND");
      workflow.endStep({ mode: "parallel_streaming" });
    }

    // Only send completion updates if this response is still current
    if (session.currentResponseId === responseId) {
      // STEP 11: Send timing info
      workflow.startStep("STEP11_TIMING_SEND");
      workflow.logSummary();
      sendWorkflowTiming(ws, workflow, response.usedTool);
      workflow.endStep();

      // STEP 12: Complete
      workflow.startStep("STEP12_COMPLETE");
      session.status = "idle";
      sendStatus(ws, "idle", response.emotion, "");
      workflow.endStep();
    } else {
      log.debug(`[${session.id.slice(0, 8)}] Skipping completion (cancelled)`);
    }

  } catch (error) {
    const isAbort = error instanceof Error && (error.name === "AbortError" || error.name === "APIUserAbortError");
    if (isAbort) {
      sessionLog.debug("LLM call aborted (superseded by barge-in)");
    } else {
      sessionLog.error("Process input error:", error);
      log.error("Process input error:", error);
    }
    // Only update status if this response is still current
    // (an aborted request is by definition no longer current, so this is also skipped for it)
    if (session.currentResponseId === responseId) {
      workflow.logSummary();
      session.status = "idle";
      sendStatus(ws, "idle", "confused", "");
      sendError(ws, "An error occurred. Please try again.");
    }
  } finally {
    // Always reset pending flag
    session.pendingRequest = false;
    // Clear the abort controller only if it's still ours (a newer request may have replaced it)
    if (session.currentAbortController === abortController) {
      session.currentAbortController = null;
    }
  }
}

/**
 * Handle incoming WebSocket message
 */
async function handleMessage(session: Session, data: string): Promise<void> {
  // Update last activity time
  session.lastActivityTime = Date.now();

  try {
    const message = JSON.parse(data) as WSMessage;

    switch (message.type) {
      case "text_input": {
        const text = message.text as string;
        if (text && text.trim()) {
          const trimmedText = text.trim();

          // Validate message length
          if (trimmedText.length > MAX_MESSAGE_LENGTH) {
            session.log.warn(`Message too long: ${trimmedText.length} chars`);
            sendError(session.ws, `Message is too long (max ${MAX_MESSAGE_LENGTH} characters)`);
            return;
          }

          // Check rate limit
          if (!checkRateLimit(session)) {
            session.log.warn("Rate limit exceeded");
            sendError(session.ws, "Too many requests. Please wait a moment and try again.");
            return;
          }

          await processUserInput(session, trimmedText);
        }
        break;
      }

      case "set_user_info": {
        // Get random user from database
        session.log.info(`🎲 Fetching random user...`);
        const userProfile = await getRandomUser();
        
        if (userProfile) {
          const context = userProfileToContext(userProfile);
          session.userId = context.userId.toString();
          session.userName = context.nickName;
          session.userContext = context;
          
          // Update logger to use actual user ID instead of "guest"
          session.log = createUserLogger("WS", session.userId);
          setUserId(session.userId);  // Update global context
          
          // Console log for visibility
          console.log(`\n👤 User Authenticated: ${context.nickName} (ID: ${session.userId})`);
          console.log(`   📝 Switched log file to: backend/logs/userid-${session.userId}.log`);
          console.log(`   🎯 All future logs will append to this file\n`);
          
          // Detailed user info logging
          session.log.info(`✅ Random user selected: ${context.nickName} (ID: ${context.userId})`);
          session.log.info(`📊 User Details:`);
          if (context.age) session.log.info(`   - Age: ${context.age}歳`);
          if (context.gender) session.log.info(`   - Gender: ${context.gender}`);
          if (context.province) session.log.info(`   - Location: ${context.province}`);
          if (context.introduction) session.log.info(`   - Intro: ${context.introduction}`);
          if (context.interests && context.interests.length > 0) {
            session.log.info(`   - Interests: ${context.interests.join(', ')}`);
          }
          
          send(session.ws, { 
            type: "user_info_set", 
            success: true,
            user: context
          });
        } else {
          session.log.warn(`❌ No users found in database`);
          send(session.ws, { 
            type: "user_info_set", 
            success: false,
            error: "No users available"
          });
        }
        break;
      }

      case "load_history": {
        const loadMsg = message as LoadHistoryMessage;
        
        if (!loadMsg.userId) {
          session.log.warn("Invalid load_history message: missing userId");
          sendError(session.ws, "User ID is required");
          return;
        }

        try {
          const limit = loadMsg.limit || 5;
          session.log.info(`📜 Loading ${limit} recent history items for user ${loadMsg.userId}`);
          
          // Get recent conversation history for this user
          const records = await getConversationHistoryByUserId(loadMsg.userId, undefined, limit);
          
          // Convert to conversation turns (reverse to get chronological order)
          const history = recordsToTurns(records.reverse());
          
          session.log.info(`✅ Loaded ${history.length} history items`);
          
          // Send history to client
          const historyMsg: HistoryLoadedMessage = {
            type: "history_loaded",
            history,
          };
          send(session.ws, historyMsg);
        } catch (error) {
          session.log.error("Failed to load history:", error);
          sendError(session.ws, "Failed to load history");
        }
        break;
      }

      case "save_archive": {
        const archiveMsg = message as SaveArchiveMessage;
        
        if (!archiveMsg.userId || !archiveMsg.domain || !archiveMsg.itemId) {
          session.log.warn("Invalid save_archive message: missing required fields");
          sendError(session.ws, "Missing information required to save");
          return;
        }

        try {
          // Save to archive
          await saveToArchive(
            archiveMsg.userId,
            archiveMsg.domain,
            archiveMsg.itemId,
            archiveMsg.itemTitle,
            archiveMsg.itemData
          );
          
          // Get friends who also saved this item
          const friendsMatched = await getFriendsWhoSavedItem(
            archiveMsg.userId,
            archiveMsg.domain,
            archiveMsg.itemId
          );
          
          session.log.info(`📚 Saved to archive: ${archiveMsg.domain}/${archiveMsg.itemId} for user ${archiveMsg.userId}, friendsMatched=${friendsMatched.length}`);
          
          send(session.ws, {
            type: "archive_saved",
            success: true,
            message: "Saved to archive",
            itemId: archiveMsg.itemId,
            domain: archiveMsg.domain,
            friends_matched: friendsMatched,
          });
        } catch (error) {
          session.log.error("Failed to save to archive:", error);
          sendError(session.ws, "Failed to save to archive");
        }
        break;
      }

      case "request_greeting": {
        session.log.info("👋 Greeting requested");
        
        // Personalized greeting if user context is available
        let greeting = "Hello!";
        if (session.userContext?.nickName) {
          greeting = `Hey, ${session.userContext.nickName}! How are you?`;
          session.log.info(`📋 Personalized greeting for ${session.userContext.nickName}`);
        } else {
          session.log.debug("No user context available for personalization");
        }
        
        sendAssistantMessage(session.ws, greeting, "happy");
        const greetingTurn: ConversationTurn = { 
          role: "assistant", 
          content: greeting,
          domain: "general",
          emotion: "happy"
        };
        session.history.push(greetingTurn);
        
        // Save greeting to database (async, don't block)
        saveConversationTurn(
          session.id, 
          greetingTurn, 
          "general", 
          session.userId, 
          session.userName, 
          session.userToken
        ).catch(err => {
          session.log.error("Failed to save greeting to database:", err);
        });
        
        session.log.debug(`Greeting sent: "${greeting}" (text only, no audio)`);
        break;
      }

      case "select_item": {
        // Handle card tap / touch selection from frontend
        const selectMsg = message as unknown as SelectItemMessage;
        const { index, itemId, action } = selectMsg;
        
        session.log.info(`👆 Item selected: index=${index}, itemId=${itemId}, action=${action}`);
        
        if (session.activeResults && index >= 0 && index < session.activeResults.items.length) {
          session.activeResults.selectedIndex = index;
          const selectedItem = session.activeResults.items[index];
          const entityName = getItemName(selectedItem, session.activeResults.type);
          
          session.log.info(`🔢 Touch selection: ${index + 1}番 → "${entityName}"`);
          
          // If action is "detail", trigger an auto-response about the item
          if (action === "detail") {
            const detailText = `[User selected "${entityName}"] Tell me about item ${index + 1}`;
            await processUserInput(session, detailText);
          }
          // If action is "save", the frontend handles it directly via save_archive
          // "focus" just updates the selected index (done above)
        }
        break;
      }

      case "ping": {
        send(session.ws, { type: "pong" });
        break;
      }

      // ================================================================
      // New unified message type (voice_event)
      // Supports the improved communication pattern
      // ================================================================
      case "voice_event": {
        const voiceEvent = message as unknown as VoiceEventMessage;
        const eventName = voiceEvent.event?.name;
        
        session.log.debug(`Received voice_event: ${eventName}`);
        
        switch (eventName) {
          case "text_input": {
            const text = voiceEvent.text;
            if (text && text.trim()) {
              const trimmedText = text.trim();
              
              // Validate message length
              if (trimmedText.length > MAX_MESSAGE_LENGTH) {
                session.log.warn(`Message too long: ${trimmedText.length} chars`);
                sendError(session.ws, `Message is too long (max ${MAX_MESSAGE_LENGTH} characters)`);
                return;
              }
              
              // Check rate limit
              if (!checkRateLimit(session)) {
                session.log.warn("Rate limit exceeded");
                sendError(session.ws, "Too many requests. Please wait a moment and try again.");
                return;
              }
              
              await processUserInput(session, trimmedText);
            }
            break;
          }
          
          case "set_user_info": {
            // Get random user from database
            session.log.info(`🎲 Fetching random user...`);
            const userProfile = await getRandomUser();
            
            if (userProfile) {
              const context = userProfileToContext(userProfile);
              session.userId = context.userId.toString();
              session.userName = context.nickName;
              session.userContext = context;
              
              session.log = createUserLogger("WS", session.userId);
              setUserId(session.userId);
              
              session.log.info(`✅ Random user selected: ${context.nickName} (ID: ${context.userId})`);
              
              send(session.ws, { 
                type: "user_info_set", 
                success: true,
                user: context
              });
            } else {
              session.log.warn(`❌ No users found in database`);
              send(session.ws, { 
                type: "user_info_set", 
                success: false,
                error: "No users available"
              });
            }
            break;
          }
          
          case "load_history": {
            const userId = voiceEvent.context?.userId || voiceEvent.params?.userId as string;
            const limit = (voiceEvent.params?.limit as number) || 5;
            
            if (!userId) {
              session.log.warn("Invalid load_history: missing userId");
              sendError(session.ws, "User ID is required");
              return;
            }
            
            try {
              session.log.info(`📜 Loading ${limit} recent history items for user ${userId}`);
              const records = await getConversationHistoryByUserId(userId, undefined, limit);
              const history = recordsToTurns(records.reverse());
              
              session.log.info(`✅ Loaded ${history.length} history items`);
              
              const historyMsg: HistoryLoadedMessage = {
                type: "history_loaded",
                history,
              };
              send(session.ws, historyMsg);
            } catch (error) {
              session.log.error("Failed to load history:", error);
              sendError(session.ws, "Failed to load history");
            }
            break;
          }
          
          case "save_archive": {
            const userId = voiceEvent.context?.userId || voiceEvent.params?.userId as string;
            const domain = voiceEvent.params?.domain as DomainType;
            const itemId = voiceEvent.params?.itemId as string;
            const itemTitle = voiceEvent.params?.itemTitle as string | undefined;
            const itemData = voiceEvent.params?.itemData as Record<string, unknown> | undefined;
            
            if (!userId || !domain || !itemId) {
              session.log.warn("Invalid save_archive: missing required fields");
              sendError(session.ws, "Missing information required to save");
              return;
            }
            
            try {
              await saveToArchive(userId, domain, itemId, itemTitle, itemData);
              const friendsMatched = await getFriendsWhoSavedItem(userId, domain, itemId);
              
              session.log.info(`📚 Saved to archive: ${domain}/${itemId} for user ${userId}`);
              
              send(session.ws, {
                type: "archive_saved",
                success: true,
                message: "Saved to archive",
                itemId,
                domain,
                friends_matched: friendsMatched,
              });
            } catch (error) {
              session.log.error("Failed to save to archive:", error);
              sendError(session.ws, "Failed to save to archive");
            }
            break;
          }
          
          case "request_greeting": {
            session.log.info("👋 Greeting requested (voice_event)");
            
            let greeting = "Hello!";
            if (session.userContext?.nickName) {
              greeting = `Hey, ${session.userContext.nickName}! How are you?`;
            }
            
            sendAssistantMessage(session.ws, greeting, "happy");
            const greetingTurn: ConversationTurn = { 
              role: "assistant", 
              content: greeting,
              domain: "general",
              emotion: "happy"
            };
            session.history.push(greetingTurn);
            
            saveConversationTurn(
              session.id, 
              greetingTurn, 
              "general", 
              session.userId, 
              session.userName, 
              session.userToken
            ).catch(err => {
              session.log.error("Failed to save greeting to database:", err);
            });
            break;
          }
          
          case "ping": {
            send(session.ws, { type: "pong" });
            break;
          }
          
          default:
            session.log.warn(`Unknown voice_event name: ${eventName}`);
        }
        break;
      }

      // ─── 9Router STT Messages (buffered streaming) ───
      case "stt_start": {
        const sttConfig: NineRouterSTTConfig = {
          languageCode: (message as any).languageCode || "en-US",
          sampleRateHertz: (message as any).sampleRate || 16000,
          encoding: (message as any).encoding || "LINEAR16",
          enableInterimResults: true,
          model: (message as any).model,
        };

        // Stop existing session if any
        if (session.sttSession) {
          session.log.debug("Stopping existing STT session before starting new one");
          session.sttSession.destroy();
          session.sttSession = null;
        }

        try {
          session.sttSession = createNineRouterSTTSession(sttConfig, {
            onTranscript: (text, isFinal, confidence) => {
              send(session.ws, {
                type: "stt_transcript",
                text,
                isFinal,
                confidence,
              } as any);
            },
            onError: (error) => {
              session.log.error("9Router STT error:", error);
              send(session.ws, {
                type: "stt_error",
                error: error.message,
              } as any);
            },
            onStarted: () => {
              session.log.debug("9Router STT session started");
              send(session.ws, { type: "stt_started" } as any);
            },
            onStopped: () => {
              session.log.debug("9Router STT session stopped");
              send(session.ws, { type: "stt_stopped" } as any);
            },
          });

          await session.sttSession.start();
          session.log.info("🎙️ 9Router STT session started", { config: sttConfig });
        } catch (error) {
          session.log.error("Failed to start 9Router STT:", error);
          send(session.ws, {
            type: "stt_error",
            error: `Failed to start speech recognition: ${error instanceof Error ? error.message : String(error)}`,
          } as any);
          session.sttSession = null;
        }
        break;
      }

      case "stt_audio": {
        // Forward audio data to 9Router STT buffer
        if (session.sttSession) {
          try {
            const base64Data = (message as any).data;
            if (base64Data) {
              const audioBuffer = Buffer.from(base64Data, "base64");
              session.sttSession.writeAudio(audioBuffer);
            }
          } catch (error) {
            session.log.error("Error processing STT audio:", error);
          }
        }
        break;
      }

      case "stt_stop": {
        if (session.sttSession) {
          session.sttSession.stop();
          session.sttSession = null;
          session.log.info("🛑 9Router STT session stopped");
        }
        break;
      }

      case "stt_finalize": {
        // Frontend just promoted an interim transcript to final (one utterance done).
        // Clear the rolling audio buffer so the next utterance's window doesn't still
        // contain this one's audio — mic stays on, so the session itself isn't restarted.
        if (session.sttSession) {
          session.sttSession.finalizeUtterance();
        }
        break;
      }

      default:
        session.log.warn(`Unknown message type: ${message.type}`);
        log.warn("Unknown message type:", message.type);
    }
  } catch (error) {
    session.log.error("Handle message error:", error);
    log.error("Handle message error:", error);
    sendError(session.ws, "Failed to process message");
  }
}

/**
 * Handle new WebSocket connection
 */
export function handleConnection(ws: WebSocket): void {
  const sessionId = uuidv4();
  
  // Create user-specific logger (logs to logs/userid-{userId}.log when DEBUG=true)
  // Initially use "guest" as userId until user authenticates
  const initialUserId = "guest";
  const sessionLog = createUserLogger("WS", initialUserId);
  
  const now = Date.now();
  const session: Session = {
    id: sessionId,
    ws,
    history: [],
    status: "idle",
    pendingRequest: false,
    currentResponseId: null,
    currentAbortController: null,
    lastActivityTime: now,
    requestCount: 0,
    requestWindowStart: now,
    log: sessionLog,  // Add user-specific logger
    currentDomain: "general",  // Initialize with general domain
    userId: initialUserId,  // Initialize with "guest"
    activeResults: null,  // No active results initially
    sttSession: null,     // No STT session initially
  };

  sessions.set(sessionId, session);
  
  // Set global user ID for logging context
  setUserId(initialUserId);
  
  // Console log for visibility
  console.log(`\n🔌 WebSocket Connected: ${sessionId.slice(0, 8)}...`);
  console.log(`   📝 Log file: backend/logs/userid-${initialUserId}.log`);
  console.log(`   👤 User: ${initialUserId} (will change after auth)\n`);
  
  log.info(`Client connected: ${sessionId}`);
  sessionLog.info("WebSocket connection established");

  // Send welcome message
  send(ws, {
    type: "connected",
    sessionId,
    message: "Connected to Rabbit AI!",
  });

  // Send initial status
  sendStatus(ws, "idle", "neutral", "");

  // Don't send greeting immediately - wait for frontend to load history first
  // Frontend will request greeting after history is loaded

  // Handle incoming messages
  ws.on("message", (data) => {
    handleMessage(session, data.toString());
  });

  // Handle close
  ws.on("close", () => {
    // Clean up Google STT session if active
    if (session.sttSession) {
      session.sttSession.destroy();
      session.sttSession = null;
      sessionLog.debug("Google STT session cleaned up on disconnect");
    }
    
    clearUserId();  // Clear global user ID context
    sessions.delete(sessionId);
    log.info(`Client disconnected: ${sessionId}`);
    sessionLog.info("WebSocket connection closed");
  });

  // Handle errors
  ws.on("error", (error) => {
    log.error(`WebSocket error for ${sessionId}:`, error);
    sessionLog.error("WebSocket error", error);
    sessions.delete(sessionId);
  });
}

/**
 * Get active session count
 */
export function getSessionCount(): number {
  return sessions.size;
}
