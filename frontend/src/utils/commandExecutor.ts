/**
 * Command Executor
 * 
 * Executes detected commands locally on the client side.
 * Save commands resolve the target item from search results by number,
 * current selection, or FILO fallback.
 */

import type { DomainType, ChatMessage, SearchResults } from "@/types";
import type { CommandType } from "./voiceCommands";
import { extractSelectionNumber } from "./selectionResolver";
import { createLogger } from "./logger";
import archiveStorage from "./archiveStorage";

const log = createLogger("CommandExecutor");

// ============================================================================
// Types
// ============================================================================

export interface CommandContext {
  userId: string | null;
  saveToArchive: (
    userId: string,
    domain: DomainType,
    itemId: string,
    itemTitle?: string,
    itemData?: Record<string, unknown>
  ) => void;
  /** Original user text (for extracting numbers) */
  originalText?: string;
  /** Current chat messages (for accessing search results) */
  messages?: ChatMessage[];
  /** Currently selected card index in SearchResultsPanel */
  selectedIndex?: number | null;
}

export interface CommandResult {
  success: boolean;
  message: string;
  shouldSendToBackend: boolean;
}

type CommandHandler = (context: CommandContext) => CommandResult;

// ============================================================================
// Helpers
// ============================================================================

const fail = (message: string): CommandResult => ({
  success: false, message, shouldSendToBackend: false,
});

const ok = (message: string): CommandResult => ({
  success: true, message, shouldSendToBackend: false,
});

const forward = (): CommandResult => ({
  success: true, message: "", shouldSendToBackend: true,
});

/** Find latest search results from messages (newest first) */
function findLatestSearchResults(messages?: ChatMessage[]): SearchResults | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.searchResults && msg.searchResults.total > 0) {
      return msg.searchResults;
    }
  }
  return undefined;
}

/** Extract a 1-based item number from text (Japanese patterns + bare number fallback) */
function extractItemNumber(text: string): number | null {
  // Try Japanese patterns first (1番, 10番, 一番, いちばん, etc.)
  const num = extractSelectionNumber(text);
  if (num !== null) return num;

  // Fallback: bare number (safe in save-command context)
  const digitMatch = text.match(/([1-9]\d*)/);
  return digitMatch ? parseInt(digitMatch[1]) : null;
}

/** Save a movie item by index, returns CommandResult */
function saveMovie(
  results: SearchResults,
  index: number,
  userId: string,
  saveToArchive: CommandContext["saveToArchive"],
): CommandResult {
  const movie = results.movies?.[index];
  if (!movie) {
    return fail(`Couldn't find movie #${index + 1}`);
  }
  const itemId = movie.id?.toString() || `movie-${Date.now()}`;
  saveToArchive(userId, "movie", itemId, movie.title_ja, {
    title_en: movie.title_en,
    description: movie.description,
    release_year: movie.release_year,
    rating: movie.rating,
    director: movie.director,
    actors: movie.actors,
  });
  log.info(`✅ Saved movie #${index + 1} "${movie.title_ja}" (${itemId})`);
  return ok(`Saved ${movie.title_ja} to archive`);
}

/** Save a gourmet item by index, returns CommandResult */
function saveGourmet(
  results: SearchResults,
  index: number,
  userId: string,
  saveToArchive: CommandContext["saveToArchive"],
): CommandResult {
  const restaurant = results.restaurants?.[index];
  if (!restaurant) {
    return fail(`Couldn't find restaurant #${index + 1}`);
  }
  const itemId = restaurant.id?.toString() || `gourmet-${Date.now()}`;
  saveToArchive(userId, "gourmet", itemId, restaurant.name, {
    code: restaurant.code,
    address: restaurant.address,
    catch_copy: restaurant.catch_copy,
    urls_pc: restaurant.urls_pc,
    open_hours: restaurant.open_hours,
    close_days: restaurant.close_days,
    access: restaurant.access,
  });
  log.info(`✅ Saved restaurant #${index + 1} "${restaurant.name}" (${itemId})`);
  return ok(`Saved ${restaurant.name} to archive`);
}

// ============================================================================
// Command Handlers
// ============================================================================

const COMMAND_HANDLERS: Record<CommandType, CommandHandler> = {
  /**
   * SAVE - Save an item to user's archive.
   * Resolution priority:
   *   1. Number in text ("save 1", "1番保存") → specific item from search results
   *   2. Currently selected/focused card in SearchResultsPanel
   *   3. Most recent item from FILO storage (archiveStorage.peek())
   */
  save: ({ userId, saveToArchive, originalText, messages, selectedIndex }) => {
    if (!userId) return fail("Please log in");

    const results = findLatestSearchResults(messages);

    // Resolve target index: number in text → selected card → null
    let targetIndex: number | null = null;

    if (originalText) {
      const num = extractItemNumber(originalText);
      if (num !== null) {
        targetIndex = num - 1;
        log.debug(`🔢 Number from text: ${num} → index ${targetIndex}`);
      }
    }

    if (targetIndex === null && selectedIndex != null) {
      targetIndex = selectedIndex;
      log.debug(`🎯 Using selected index: ${targetIndex}`);
    }

    // Save from search results if we have a target
    if (targetIndex !== null && results) {
      if (results.type === "movie") return saveMovie(results, targetIndex, userId, saveToArchive);
      if (results.type === "gourmet") return saveGourmet(results, targetIndex, userId, saveToArchive);
    }

    // Fallback: save most recent item from FILO storage
    const item = archiveStorage.peek();
    if (!item) return fail("No item available to save");

    saveToArchive(userId, item.itemDomain, item.itemId, item.itemTitle, item.itemData);
    log.info(`✅ Saved (fallback): ${item.itemTitle} (${item.itemDomain}:${item.itemId})`);
    return ok(`Saved ${item.itemTitle} to archive`);
  },

  // Backend-forwarded commands
  select:   () => forward(),
  detail:   () => forward(),
  next:     () => forward(),
  previous: () => forward(),

  // Unimplemented commands
  delete: () => fail("Delete is not available yet"),
  list:   () => fail("List view is not available yet"),
  clear:  () => fail("Clear is not available yet"),
};

// ============================================================================
// Public API
// ============================================================================

/** Execute a command with the given context */
export function executeCommand(
  commandType: CommandType,
  context: CommandContext,
): CommandResult {
  const handler = COMMAND_HANDLERS[commandType];
  if (!handler) {
    return fail(`Command "${commandType}" is not implemented`);
  }

  try {
    return handler(context);
  } catch (error) {
    log.error(`❌ Command execution failed:`, error);
    return fail("Failed to run command");
  }
}
