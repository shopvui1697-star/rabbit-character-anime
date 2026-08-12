/**
 * Selection Resolver - Extracts numbered selection from voice/text input
 * 
 * Handles Japanese number formats:
 * - Arabic: 1番, 2番
 * - Full-width: １番, ２番
 * - Kanji: 一番, 二番
 * - Hiragana: いちばん, にばん
 * - Ordinal: 1つ目, 一つ目
 * - Relative: 最初, 真ん中, 最後
 */

import { createLogger } from "./logger";
import type { ActiveResultSet, Movie, GourmetRestaurant } from "@/types";

const log = createLogger("SelectionResolver");

/**
 * Kanji number mapping
 */
const KANJI_TO_NUMBER: Record<string, number> = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9,
  '１': 1, '２': 2, '３': 3, '４': 4, '５': 5,
  '６': 6, '７': 7, '８': 8, '９': 9,
};

/**
 * Hiragana reading to number mapping
 */
const HIRAGANA_TO_NUMBER: Record<string, number> = {
  'いち': 1, 'に': 2, 'さん': 3, 'よん': 4, 'し': 4, 'ご': 5,
  'ろく': 6, 'なな': 7, 'しち': 7, 'はち': 8, 'きゅう': 9, 'く': 9,
};

const ENGLISH_ORDINAL_TO_NUMBER: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

/**
 * Selection patterns for extracting numbers from voice/text input
 */
const SELECTION_PATTERNS: Array<{
  pattern: RegExp;
  extract: (match: RegExpMatchArray) => number | null;
}> = [
  // English: "number 2", "#2", "item 3"
  {
    pattern: /(?:number|#|item)\s*([1-9]\d*)/i,
    extract: (m) => parseInt(m[1]),
  },
  // English ordinals: "second", "third"
  {
    pattern: /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/i,
    extract: (m) => ENGLISH_ORDINAL_TO_NUMBER[m[1].toLowerCase()] ?? null,
  },
  // Japanese: "N番" - Arabic numeral + 番 (supports multi-digit: 1番, 10番, 12番)
  {
    pattern: /([1-9]\d*)番/,
    extract: (m) => parseInt(m[1]),
  },
  // "Ｎ番" - Full-width numeral + 番 (single-digit only)
  {
    pattern: /([１-９])番/,
    extract: (m) => KANJI_TO_NUMBER[m[1]] ?? null,
  },
  // "漢字番" - Kanji numeral + 番 (single-digit only)
  {
    pattern: /([一二三四五六七八九])番/,
    extract: (m) => KANJI_TO_NUMBER[m[1]] ?? null,
  },
  // "Nつ目" - Arabic ordinal (supports multi-digit: 1つ目, 10つ目)
  {
    pattern: /([1-9]\d*)つ目/,
    extract: (m) => parseInt(m[1]),
  },
  // "漢字つ目" - Kanji ordinal (single-digit only)
  {
    pattern: /([一二三四五])つ目/,
    extract: (m) => KANJI_TO_NUMBER[m[1]] ?? null,
  },
  // Hiragana variants: いちばん, にばん, etc. (single-digit only)
  {
    pattern: /(いち|に|さん|よん|ご)ばん/,
    extract: (m) => HIRAGANA_TO_NUMBER[m[1]] ?? null,
  },
];

/**
 * Relative selection patterns
 */
const RELATIVE_PATTERNS: Array<{
  pattern: RegExp;
  resolve: (totalItems: number, currentIndex: number | null) => number | null;
}> = [
  // English relative selection
  {
    pattern: /\b(first|top)\b/i,
    resolve: (total) => total > 0 ? 0 : null,
  },
  {
    pattern: /\b(last|bottom)\b/i,
    resolve: (total) => total > 0 ? total - 1 : null,
  },
  {
    pattern: /\b(middle|center)\b/i,
    resolve: (total) => total >= 3 ? Math.floor(total / 2) : null,
  },
  // Japanese relative selection
  // "最初" "最初の" - first item
  {
    pattern: /最初/,
    resolve: (total) => total > 0 ? 0 : null,
  },
  // "最後" "最後の" - last item
  {
    pattern: /最後/,
    resolve: (total) => total > 0 ? total - 1 : null,
  },
  // "真ん中" - middle item
  {
    pattern: /真ん中/,
    resolve: (total) => total >= 3 ? Math.floor(total / 2) : null,
  },
  // "上の" - previous (relative to current)
  {
    pattern: /上の/,
    resolve: (total, current) => current !== null && current > 0 ? current - 1 : null,
  },
  // "下の" - next (relative to current)
  {
    pattern: /下の/,
    resolve: (total, current) => current !== null && current < total - 1 ? current + 1 : null,
  },
];

/**
 * Extract a 1-based selection number from Japanese text
 * Returns null if no number selection is detected
 */
export function extractSelectionNumber(text: string): number | null {
  for (const { pattern, extract } of SELECTION_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const num = extract(match);
      if (num !== null && num >= 1) {
        log.debug(`Extracted selection number: ${num} from "${text}"`);
        return num;
      }
    }
  }
  return null;
}

/**
 * Extract a 0-based selection index using relative patterns
 * Requires knowing the total items and optionally the current selection
 */
export function extractRelativeSelection(
  text: string,
  totalItems: number,
  currentIndex: number | null
): number | null {
  for (const { pattern, resolve } of RELATIVE_PATTERNS) {
    if (pattern.test(text)) {
      const idx = resolve(totalItems, currentIndex);
      if (idx !== null) {
        log.debug(`Extracted relative selection: index ${idx} from "${text}"`);
        return idx;
      }
    }
  }
  return null;
}

/**
 * Check if text contains a selection command (numbered or relative)
 */
export function isSelectionCommand(text: string): boolean {
  return extractSelectionNumber(text) !== null ||
    /\b(first|last|middle|center|top|bottom)\b/i.test(text) ||
    /最初|最後|真ん中|上の|下の/.test(text);
}

/**
 * Resolve a numbered selection to an actual item from the active result set
 * 
 * @param number 1-based selection number (user says "2番")
 * @param activeResults Current active result set
 * @returns The resolved item and its 0-based index, or null if invalid
 */
export function resolveSelection(
  number: number,
  activeResults: ActiveResultSet
): { item: Movie | GourmetRestaurant; index: number } | null {
  const index = number - 1; // Convert to 0-based

  if (index < 0 || index >= activeResults.items.length) {
    log.debug(`Selection ${number} out of range (${activeResults.items.length} items)`);
    return null;
  }

  return {
    item: activeResults.items[index],
    index,
  };
}

/**
 * Get the display name of an item (works for both Movie and GourmetRestaurant)
 */
export function getItemDisplayName(
  item: Movie | GourmetRestaurant,
  type: "movie" | "gourmet"
): string {
  if (type === "movie") {
    return (item as Movie).title_ja;
  }
  return (item as GourmetRestaurant).name;
}
