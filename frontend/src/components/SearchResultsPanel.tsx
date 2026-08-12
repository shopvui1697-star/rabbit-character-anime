"use client";

import React, { memo, useMemo, useCallback, useRef, useEffect } from "react";
import type { ChatMessage, DomainType, ArchiveItemInfo, FriendMatch, SearchResults as SearchResultsType } from "@/types";
import { MovieCard } from "./MovieCard";
import { GourmetCard } from "./GourmetCard";
import { useArchiveStorage } from "@/hooks/useArchiveStorage";
import styles from "./SearchResultsPanel.module.css";

interface SearchResultsPanelProps {
  messages: ChatMessage[];
  userId: string | null;
  onSaveToArchive?: (userId: string, domain: DomainType, itemId: string, itemTitle?: string, itemData?: Record<string, unknown>) => void;
  /** Currently selected/focused card index (0-based), from voice or touch */
  selectedIndex?: number | null;
  /** Callback when user taps a card */
  onCardSelect?: (index: number, itemId: string, action: "focus" | "detail" | "save") => void;
}

/**
 * SearchResultsPanel - Renders movie/gourmet search results in a dedicated panel
 * 
 * This component displays the latest search results from assistant messages.
 * It is separate from ChatHistory which only shows text messages.
 */
export const SearchResultsPanel = memo(function SearchResultsPanel({
  messages,
  userId,
  onSaveToArchive,
  selectedIndex = null,
  onCardSelect,
}: SearchResultsPanelProps) {
  // Get archive state
  const { items: archiveItems, isSaved, getFriendsMatched } = useArchiveStorage();
  
  // Refs for scrolling selected card into view
  const cardRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  
  // Find the latest message with search results
  const latestSearchResult = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && msg.searchResults && msg.searchResults.total > 0) {
        return msg;
      }
    }
    return null;
  }, [messages]);

  // Create version for re-render detection
  const archiveVersion = useMemo(() => {
    return archiveItems.length + archiveItems.filter(item => item.savedAt).length;
  }, [archiveItems]);

  // Auto-scroll selected card into view
  useEffect(() => {
    if (selectedIndex !== null && selectedIndex !== undefined) {
      const cardEl = cardRefs.current.get(selectedIndex);
      if (cardEl) {
        cardEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
  }, [selectedIndex]);

  // Handle card click
  const handleCardClick = useCallback((index: number, itemId: string) => {
    if (onCardSelect) {
      onCardSelect(index, itemId, "focus");
    }
  }, [onCardSelect]);

  if (!latestSearchResult || !latestSearchResult.searchResults) {
    return (
      <div className={styles.container}>
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>🔍</div>
          <p className={styles.emptyText}>Search results will appear here</p>
          <p className={styles.emptySubtext}>Try searching for movies or restaurants</p>
        </div>
      </div>
    );
  }

  const { searchResults, content } = latestSearchResult;

  return (
    <div className={styles.container}>
      {/* Header with assistant's comment */}
      {content && (
        <div className={styles.assistantComment}>
          <span className={styles.commentIcon}>💬</span>
          <span>{content}</span>
        </div>
      )}
      
      {/* Results header */}
      <div className={styles.resultsHeader}>
        <h3 className={styles.resultsTitle}>
          {searchResults.type === "movie" ? "🎬 Search Results" : "🍽️ Search Results"}
        </h3>
        <span className={styles.resultsCount}>{searchResults.total} results</span>
      </div>
      
      {/* Results grid */}
      <div className={styles.resultsGrid}>
        {searchResults.type === "movie" && searchResults.movies?.map((movie, index) => {
          const itemId = movie.id?.toString() || `movie-${Date.now()}-${Math.random()}`;
          const itemIsSaved = isSaved(itemId, "movie");
          const itemFriendsMatched = itemIsSaved ? getFriendsMatched(itemId, "movie") : [];
          const isSelected = selectedIndex === index;
          
          const movieArchiveItem: ArchiveItemInfo = {
            itemId,
            itemTitle: movie.title_ja,
            itemDomain: "movie",
            itemData: {
              title_en: movie.title_en,
              description: movie.description,
              overview: movie.overview,
              poster_path: movie.poster_path,
              release_year: movie.release_year,
              rating: movie.rating,
              director: movie.director,
              actors: movie.actors,
            },
          };
          
          return (
            <div
              key={itemId}
              ref={(el) => { if (el) cardRefs.current.set(index, el); }}
              className={`${styles.cardWrapper} ${isSelected ? styles.cardSelected : ''}`}
              onClick={() => handleCardClick(index, itemId)}
              role="button"
              tabIndex={0}
              aria-label={`Search result ${index + 1}: ${movie.title_ja}`}
              aria-selected={isSelected}
            >
              {/* Number badge */}
              <div className={styles.numberBadge} aria-hidden="true">
                <span>{index + 1}</span>
              </div>
              <MovieCard
                archiveItem={movieArchiveItem}
                isSaved={itemIsSaved}
                onSave={() => {
                  if (userId && onSaveToArchive && !itemIsSaved) {
                    onSaveToArchive(userId, "movie", itemId, movie.title_ja, movieArchiveItem.itemData);
                  }
                }}
                onDetail={() => onCardSelect?.(index, itemId, "detail")}
                friendsMatched={itemFriendsMatched}
              />
            </div>
          );
        })}
        
        {searchResults.type === "gourmet" && searchResults.restaurants?.map((restaurant, index) => {
          const itemId = restaurant.id?.toString() || `gourmet-${Date.now()}-${Math.random()}`;
          const itemIsSaved = isSaved(itemId, "gourmet");
          const itemFriendsMatched = itemIsSaved ? getFriendsMatched(itemId, "gourmet") : [];
          const isSelected = selectedIndex === index;
          
          const gourmetArchiveItem: ArchiveItemInfo = {
            itemId,
            itemTitle: restaurant.name,
            itemDomain: "gourmet",
            itemData: {
              code: restaurant.code,
              name_short: restaurant.name_short,
              address: restaurant.address,
              catch_copy: restaurant.catch_copy,
              urls_pc: restaurant.urls_pc,
              open_hours: restaurant.open_hours,
              close_days: restaurant.close_days,
              access: restaurant.access,
              capacity: restaurant.capacity,
              lat: restaurant.lat,
              lng: restaurant.lng,
              budget_id: restaurant.budget_id,
            },
          };
          
          return (
            <div
              key={itemId}
              ref={(el) => { if (el) cardRefs.current.set(index, el); }}
              className={`${styles.cardWrapper} ${isSelected ? styles.cardSelected : ''}`}
              onClick={() => handleCardClick(index, itemId)}
              role="button"
              tabIndex={0}
              aria-label={`Search result ${index + 1}: ${restaurant.name}`}
              aria-selected={isSelected}
            >
              {/* Number badge */}
              <div className={styles.numberBadge} aria-hidden="true">
                <span>{index + 1}</span>
              </div>
              <GourmetCard
                archiveItem={gourmetArchiveItem}
                isSaved={itemIsSaved}
                onSave={() => {
                  if (userId && onSaveToArchive && !itemIsSaved) {
                    onSaveToArchive(userId, "gourmet", itemId, restaurant.name, gourmetArchiveItem.itemData);
                  }
                }}
                onDetail={() => onCardSelect?.(index, itemId, "detail")}
                friendsMatched={itemFriendsMatched}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});
