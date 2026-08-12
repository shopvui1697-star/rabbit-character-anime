/**
 * Google Custom Search Service
 *
 * Provides web search capability for movie information
 * Used in parallel with database search for better coverage
 */

import { config } from "../config/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("GoogleSearch");

export interface GoogleSearchResult {
  title: string;
  link: string;
  snippet: string;
}

export interface GoogleSearchResponse {
  results: GoogleSearchResult[];
  total: number;
  source: "google";
}

// Cache for Google search results
const GOOGLE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const GOOGLE_CACHE_LIMIT = 100;
const googleSearchCache = new Map<string, { value: GoogleSearchResponse; timestamp: number }>();

function getCacheKey(query: string): string {
  return query.trim().toLowerCase();
}

function getCachedResult(key: string): GoogleSearchResponse | null {
  const entry = googleSearchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > GOOGLE_CACHE_TTL_MS) {
    googleSearchCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedResult(key: string, value: GoogleSearchResponse): void {
  if (googleSearchCache.size >= GOOGLE_CACHE_LIMIT) {
    const firstKey = googleSearchCache.keys().next().value as string | undefined;
    if (firstKey) {
      googleSearchCache.delete(firstKey);
    }
  }
  googleSearchCache.set(key, { value, timestamp: Date.now() });
}

/**
 * Search Google Custom Search API for movie information
 *
 * @param query Search query (movie name, etc.)
 * @returns Search results from Google
 */
export async function searchGoogle(query: string): Promise<GoogleSearchResponse> {
  const { apiKey, searchEngineId } = config.google;

  // Return empty if not configured
  if (!apiKey || !searchEngineId) {
    log.debug("Google Search not configured (missing API key or search engine ID)");
    return { results: [], total: 0, source: "google" };
  }

  // Check cache first
  const cacheKey = getCacheKey(query);
  const cached = getCachedResult(cacheKey);
  if (cached) {
    log.debug(`Google search (cached): "${query}"`);
    return cached;
  }

  try {
    // Add movie-related context to search query for better results
    const searchQuery = `${query} movie plot summary`;

    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("cx", searchEngineId);
    url.searchParams.set("q", searchQuery);
    url.searchParams.set("num", "5"); // Limit to 5 results
    url.searchParams.set("lr", "lang_en"); // Prefer English results
    url.searchParams.set("safe", "active"); // Safe search

    log.debug(`Google search: "${query}" -> "${searchQuery}"`);
    const startTime = performance.now();

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error(`Google Search API error (${response.status}):`, errorText);
      return { results: [], total: 0, source: "google" };
    }

    const data = await response.json();
    const duration = Math.round(performance.now() - startTime);

    // Parse results
    const results: GoogleSearchResult[] = (data.items || []).map((item: {
      title?: string;
      link?: string;
      snippet?: string;
    }) => ({
      title: item.title || "",
      link: item.link || "",
      snippet: item.snippet || "",
    }));

    log.debug(`Google search completed: ${results.length} results in ${duration}ms`);

    const searchResponse: GoogleSearchResponse = {
      results,
      total: results.length,
      source: "google",
    };

    // Cache the result
    setCachedResult(cacheKey, searchResponse);

    return searchResponse;
  } catch (error) {
    log.error("Google search error:", error);
    return { results: [], total: 0, source: "google" };
  }
}

/**
 * Format Google search results for LLM consumption
 */
export function formatGoogleResults(response: GoogleSearchResponse): string {
  if (response.results.length === 0) {
    return "[Web search results]\nNo results";
  }

  const lines = response.results.map((result, i) => {
    return `${i + 1}. ${result.title}\n   ${result.snippet}`;
  });

  return `[Web search results]\n${lines.join("\n\n")}`;
}
