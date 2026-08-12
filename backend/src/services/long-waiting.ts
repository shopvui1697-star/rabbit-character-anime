/**
 * Long Waiting Phrases - Database query acknowledgment
 * 
 * These are longer phrases (2-4 seconds) that:
 * 1. Confirm what the user is looking for
 * 2. Tell them to wait while searching
 * 3. Give a sense of progress
 * 
 * Used specifically for database/tool operations that take time.
 * Streamed to frontend as TTS audio immediately when tool use is detected.
 */

// Template functions for context-aware waiting phrases
export interface WaitingContext {
  query?: string;      // User's search query (e.g., "action movies")
  genre?: string;      // Detected genre
  year?: number;       // Detected year
}

/**
 * Generate a context-aware waiting phrase for database search
 * 
 * @param context - Information about the search being performed
 * @returns English waiting phrase that confirms and acknowledges the search
 */
export function generateLongWaitingPhrase(context: WaitingContext): string {
  const templates = [
    "One moment, I'll look that up for you.",
    "Got it, let me check on that.",
    "Okay, I'm checking now.",
    "Sure, I'll search for that. Just a sec.",
    
    // With query confirmation
    ...(context.query ? [
      `${context.query}, got it. I'm searching now, one moment.`,
      `Okay, I'll look up ${context.query} for you.`,
      `Looking into ${context.query} for you.`,
      `Ah, ${context.query}. Checking that now.`,
    ] : []),
    
    // With genre confirmation
    ...(context.genre ? [
      `${context.genre} titles, got it. Searching now, one moment.`,
      `${context.genre}, right. Checking the database.`,
    ] : []),
    
    // With year confirmation
    ...(context.year ? [
      `Titles from ${context.year}, got it. Searching now.`,
      `${context.year}, okay. Let me look that up.`,
    ] : []),
    
    // Combined confirmations
    ...(context.genre && context.year ? [
      `${context.genre} from ${context.year}, checking now.`,
      `Got it, looking for ${context.year} ${context.genre} titles.`,
    ] : []),
  ];
  
  const index = Math.floor(Math.random() * templates.length);
  return templates[index];
}

/**
 * Simplified waiting phrases without context (fallback)
 */
export const SIMPLE_LONG_WAITING_PHRASES = [
  "One moment, I'll look that up for you.",
  "Got it, let me check on that.",
  "Okay, I'm checking now.",
  "Sure, I'll search for that. Just a sec.",
  "Checking the database, one moment please.",
  "I'll look that up right away.",
] as const;

/**
 * Get a random simple waiting phrase (no context)
 */
export function getRandomLongWaiting(): string {
  const index = Math.floor(Math.random() * SIMPLE_LONG_WAITING_PHRASES.length);
  return SIMPLE_LONG_WAITING_PHRASES[index];
}
