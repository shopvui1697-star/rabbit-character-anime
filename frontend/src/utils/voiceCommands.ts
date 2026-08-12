/**
 * Voice Command Detection and Execution
 * 
 * Detects commands in user input (voice or text) and executes them locally
 * without sending to backend. Extensible for adding new commands.
 */

import { createLogger } from "./logger";

const log = createLogger("VoiceCommands");

/**
 * Command types that can be detected
 */
export type CommandType = "save" | "delete" | "list" | "clear" | "select" | "detail" | "next" | "previous";

/**
 * Command detection result
 */
export interface CommandMatch {
  type: CommandType;
  matched: boolean;
  keyword: string;
  confidence: number; // 0-1, how confident we are this is the command
}

/**
 * Command keywords in multiple languages
 * Add new commands here for easy maintenance
 */
export const COMMAND_KEYWORDS: Record<CommandType, string[]> = {
  // Save commands
  save: [
    // Japanese
    "保存して",
    "保存する",
    "保存",
    "セーブして",
    "セーブする",
    "アーカイブに保存",
    "アーカイブに追加",
    "お気に入りに追加",
    "ブックマーク",
    // English
    "save this",
    "save it",
    "save",
    "add to archive",
    "add to favorites",
    "bookmark this",
    "bookmark it",
  ],
  
  // Delete commands (for future)
  delete: [
    "削除して",
    "削除する",
    "消して",
    "delete this",
    "remove this",
  ],
  
  // List commands (for future)
  list: [
    "リストを見せて",
    "アーカイブを見せて",
    "保存したものを見せて",
    "show my list",
    "show archive",
    "show saved items",
  ],
  
  // Clear commands (for future)
  clear: [
    "クリア",
    "全部消して",
    "clear all",
    "delete all",
  ],

  // Select commands - numbered selection ("2番", "二番目")
  // Note: for numbers beyond this list, detectCommand uses regex fallback
  select: [
    // English
    "first", "second", "third", "fourth", "fifth",
    "number one", "number two", "number three",
    // Kanji / Hiragana (single-digit only, no regex equivalent)
    "一番", "いちばん",
    "二番", "にばん",
    "三番", "さんばん",
    "四番", "よんばん",
    "五番", "ごばん",
    // Ordinal selection
    "最初", "一つ目",
    "二つ目", "三つ目",
    // Relative selection
    "それ", "真ん中",
  ],

  // Detail commands - ask for more info
  detail: [
    "tell me more", "more details", "about that", "what's it about", "details",
    "詳しく", "もっと教えて", "それについて",
    "どんな映画", "どんなお店",
    "もっと詳しく", "詳細",
  ],

  // Next commands - show more results
  next: [
    "next", "next one", "show more", "anything else", "more results",
    "次", "次の", "他にある", "もっと見せて",
    "次のページ",
  ],

  // Previous commands - go back
  previous: [
    "previous", "go back", "last one", "the one before",
    "前の", "戻って", "さっきの",
    "前のページ",
  ],
};

/**
 * Normalize text for command detection
 * Removes punctuation and extra whitespace
 */
function normalizeForCommandDetection(text: string): string {
  return text
    .toLowerCase()
    .trim()
    // Remove common Japanese and English punctuation
    .replace(/[。、！？!?,.\s]+/g, "");
}

/**
 * Regex patterns for numbered selection (handles any number: 10番, 12つ目, etc.)
 * Checked after keyword matching to avoid false positives with save/detail commands
 */
const NUMBERED_SELECT_PATTERN = /[1-9]\d*(?:番|つ目|番目|ばん)/;

/**
 * Detect if text contains a command
 * Returns the first matched command with highest confidence
 */
export function detectCommand(text: string): CommandMatch | null {
  const normalized = text.toLowerCase().trim();
  const cleanNormalized = normalizeForCommandDetection(text);
  
  // Check each command type via keyword matching
  for (const [commandType, keywords] of Object.entries(COMMAND_KEYWORDS)) {
    for (const keyword of keywords) {
      const keywordLower = keyword.toLowerCase();
      const cleanKeyword = normalizeForCommandDetection(keyword);
      
      // Check both original and cleaned versions for better matching
      const matchesOriginal = normalized.includes(keywordLower);
      const matchesCleaned = cleanNormalized.includes(cleanKeyword);
      
      if (matchesOriginal || matchesCleaned) {
        // Calculate confidence based on match quality
        const isExactMatch = cleanNormalized === cleanKeyword;
        const isStartMatch = cleanNormalized.startsWith(cleanKeyword);
        const isEndMatch = cleanNormalized.endsWith(cleanKeyword);
        
        let confidence = 0.7; // Base confidence
        if (isExactMatch) confidence = 1.0;
        else if (isStartMatch || isEndMatch) confidence = 0.9;
        
        log.debug(`✅ Command detected: ${commandType} (keyword: "${keyword}", confidence: ${confidence})`);
        
        return {
          type: commandType as CommandType,
          matched: true,
          keyword,
          confidence,
        };
      }
    }
  }
  
  // Fallback: detect numbered selection via regex (handles "10番", "12つ目", etc.)
  const numMatch = text.match(NUMBERED_SELECT_PATTERN);
  if (numMatch) {
    log.debug(`✅ Command detected: select (regex: "${numMatch[0]}")`);
    return {
      type: "select",
      matched: true,
      keyword: numMatch[0],
      confidence: 0.9,
    };
  }
  
  return null;
}

