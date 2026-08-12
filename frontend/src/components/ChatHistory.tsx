"use client";

import React, { useEffect, useRef, memo, useCallback, useMemo } from "react";
import type { ChatMessage, DomainType, SearchResults as SearchResultsType } from "@/types";
import { useArchiveStorage } from "@/hooks/useArchiveStorage";
import styles from "./ChatHistory.module.css";

interface ChatHistoryProps {
  messages: ChatMessage[];
  userId: string | null;
  onSaveToArchive?: (userId: string, domain: DomainType, itemId: string, itemTitle?: string, itemData?: Record<string, unknown>) => void;
  /** If true, show only text messages (hide search results) */
  textOnly?: boolean;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Memoized message item - only re-renders when content/isSaved changes
interface MessageItemProps {
  messageId: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  isSaved: boolean;
  canSave: boolean;
  onSave: () => void;
  searchResults?: SearchResultsType;
  textOnly?: boolean;
}

const MessageItem = memo(
  function MessageItem({ 
    role, 
    content, 
    timestamp, 
    isSaved, 
    canSave, 
    onSave, 
    searchResults,
    textOnly = false,
  }: MessageItemProps) {
    // Check if this is a movie/gourmet message with search results
    const hasSearchResults = role === "assistant" && searchResults && searchResults.total > 0;

    // In textOnly mode, render as plain text bubble (no item display)
    // Items are ONLY shown in the SearchResultsPanel which has real database item_ids
    if (textOnly && hasSearchResults) {
      return (
        <div
          className={`${styles.message} ${styles.assistant}`}
        >
          <div className={styles.bubble}>
            <span className={styles.content}>
              {content || (searchResults.type === "movie" ? "🎬 Movie search results available →" : "🍽️ Restaurant search results available →")}
            </span>
          </div>
          <div className={styles.timestamp}>{formatTime(timestamp)}</div>
        </div>
      );
    }

    return (
      <div
        className={`${styles.message} ${
          role === "user" ? styles.user : styles.assistant
        }`}
      >
        {/* Regular text bubble */}
        <div className={styles.bubble}>
          <span className={styles.content}>{content}</span>
          {(canSave || isSaved) && (
            <button
              className={styles.saveButton}
              onClick={onSave}
              title={isSaved ? "Saved" : "Save to archive"}
              disabled={isSaved}
            >
              {isSaved ? "✓" : "📚"}
            </button>
          )}
        </div>
        <div className={styles.timestamp}>{formatTime(timestamp)}</div>
      </div>
    );
  },
  // Custom comparison - only re-render when visible content changes
  (prev, next) => (
    prev.messageId === next.messageId &&
    prev.content === next.content &&
    prev.isSaved === next.isSaved &&
    prev.canSave === next.canSave &&
    prev.role === next.role &&
    prev.textOnly === next.textOnly &&
    prev.searchResults?.total === next.searchResults?.total &&
    prev.searchResults?.type === next.searchResults?.type
  )
);

// Empty handler for messages without archive capability
const noopHandler = () => {};

export function ChatHistory({ messages, userId, onSaveToArchive, textOnly = false }: ChatHistoryProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  // Cache handlers by itemId to maintain referential stability
  const handlerCacheRef = useRef<Map<string, () => void>>(new Map());

  // SINGLE SOURCE OF TRUTH: Use archiveStorage hook for saved state
  const { isSaved } = useArchiveStorage();

  // Auto-scroll to bottom on new messages only
  const prevMessagesLengthRef = useRef(messages.length);
  useEffect(() => {
    if (messages.length > prevMessagesLengthRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevMessagesLengthRef.current = messages.length;
  }, [messages.length]);

  // Create or get cached handler for an item
  const getHandler = useCallback((
    itemId: string,
    itemTitle: string | undefined,
    itemDomain: DomainType,
    itemData: Record<string, unknown> | undefined,
    content: string,
    emotion: string | undefined,
    timestamp: Date
  ): (() => void) => {
    // Return cached handler if exists
    const cached = handlerCacheRef.current.get(itemId);
    if (cached) return cached;

    // Create new handler and cache it
    const handler = () => {
      if (!userId || isSaved(itemId, itemDomain)) return;

      if (onSaveToArchive) {
        onSaveToArchive(userId, itemDomain, itemId, itemTitle, {
          ...itemData,
          content,
          emotion,
          timestamp: timestamp.toISOString(),
        });
      }
    };

    handlerCacheRef.current.set(itemId, handler);
    return handler;
  }, [userId, onSaveToArchive, isSaved]);

  // Clean up stale handlers when messages change significantly
  useEffect(() => {
    const currentItemIds = new Set(
      messages
        .filter(m => m.archiveItem?.itemId)
        .map(m => m.archiveItem!.itemId)
    );

    // Remove handlers for items no longer in messages
    for (const itemId of handlerCacheRef.current.keys()) {
      if (!currentItemIds.has(itemId)) {
        handlerCacheRef.current.delete(itemId);
      }
    }
  }, [messages]);

  // Deduplicate messages by ID to prevent echo/repeat rendering
  // MUST be before early return to maintain hook order
  const uniqueMessages = useMemo(() => {
    const seen = new Set<string>();
    const unique: typeof messages = [];
    
    for (const message of messages) {
      if (!seen.has(message.id)) {
        seen.add(message.id);
        unique.push(message);
      } else {
        console.warn(`⚠️ Duplicate message detected and removed: ${message.id}`);
      }
    }
    
    return unique;
  }, [messages]);

  // Debug: Log if we have duplicates
  useEffect(() => {
    if (uniqueMessages.length !== messages.length) {
      console.error(`🚨 Message duplication detected! Total: ${messages.length}, Unique: ${uniqueMessages.length}`);
    }
  }, [messages.length, uniqueMessages.length]);

  if (messages.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.empty}>
          Start a conversation...
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {uniqueMessages.map((message) => {
        const archiveItem = message.archiveItem;
        const itemId = archiveItem?.itemId;
        const itemDomain = archiveItem?.itemDomain;

        // Get state from archiveStorage (single source of truth)
        const itemIsSaved = itemId && itemDomain ? isSaved(itemId, itemDomain) : false;

        const canSave = message.role === "assistant" &&
                        !!archiveItem &&
                        !!userId &&
                        !!onSaveToArchive &&
                        !itemIsSaved;

        const handleSave = archiveItem
          ? getHandler(
              archiveItem.itemId,
              archiveItem.itemTitle,
              archiveItem.itemDomain,
              archiveItem.itemData,
              message.content,
              message.emotion,
              message.timestamp
            )
          : noopHandler;

        return (
          <MessageItem
            key={message.id}
            messageId={message.id}
            role={message.role}
            content={message.content}
            timestamp={message.timestamp}
            isSaved={itemIsSaved}
            canSave={canSave}
            onSave={handleSave}
            searchResults={message.searchResults}
            textOnly={textOnly}
          />
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
