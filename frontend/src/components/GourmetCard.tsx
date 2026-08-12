"use client";

import React, { memo } from "react";
import type { ArchiveItemInfo, FriendMatch } from "@/types";
import styles from "./GourmetCard.module.css";

interface GourmetCardProps {
  archiveItem: ArchiveItemInfo;
  isSaved: boolean;
  onSave: () => void;
  onDetail?: () => void;
  friendsMatched: FriendMatch[];
}

export const GourmetCard = memo(
  function GourmetCard({ archiveItem, isSaved, onSave, onDetail, friendsMatched }: GourmetCardProps) {
  const { itemTitle, itemData } = archiveItem;
  
  // Extract gourmet details
  const address = itemData?.address as string | undefined;
  const catchCopy = itemData?.catch_copy as string | undefined;
  const openHours = itemData?.open_hours as string | undefined;
  const closeDays = itemData?.close_days as string | undefined;
  const access = itemData?.access as string | undefined;
  const urlsPc = itemData?.urls_pc as string | undefined;
  const budgetId = itemData?.budget_id as number | undefined;
  const capacity = itemData?.capacity as number | undefined;
  const genre = itemData?.genre as string | undefined;
  const parking = itemData?.parking as string | undefined;
  
  // Helper to convert budget_id to display string
  const getBudgetDisplay = (id: number | undefined): string | undefined => {
    if (!id) return undefined;
    const budgetMap: Record<number, string> = {
      1: "~500円",
      2: "501~1000円",
      3: "1001~1500円",
      4: "1501~2000円",
      5: "2001~3000円",
      6: "3001~4000円",
      7: "4001~5000円",
      8: "5001~7000円",
      9: "7001~10000円",
      10: "10001~15000円",
      11: "15001~20000円",
      12: "20001~30000円",
      13: "30001円~",
    };
    return budgetMap[id];
  };
  
  const budget = getBudgetDisplay(budgetId);
  
  // Helper to safely extract string from i18n object or return as-is
  const getDisplayText = (value: unknown): string | undefined => {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value !== null && 'ja' in value) {
      return (value as { ja: string }).ja;
    }
    return undefined;
  };

  const displayTitle = getDisplayText(itemTitle);

  const handleAppointment = (friend: FriendMatch) => {
    // TODO: Implement appointment logic
    console.log(`Requesting appointment with ${friend.name} (${friend.id}) at ${displayTitle}`);
  };

  return (
    <div className={styles.gourmetCard}>
      <div className={styles.header}>
        <div className={styles.iconPlaceholder}>
          <span className={styles.icon}>🍽️</span>
        </div>
        <div className={styles.info}>
          <h3 className={styles.title}>{displayTitle}</h3>
          
          {catchCopy && <p className={styles.catchCopy}>{catchCopy}</p>}
          
          <div className={styles.metadata}>
            {genre && (
              <span className={styles.badge}>
                <span className={styles.badgeIcon}>🏷️</span> {genre}
              </span>
            )}
            {budget && (
              <span className={styles.badge}>
                <span className={styles.badgeIcon}>💰</span> {budget}
              </span>
            )}
          </div>
          
          {/* Location info */}
          {address && (
            <div className={styles.detail}>
              <span className={styles.label}>
                <span className={styles.detailIcon}>📍</span> Address:
              </span>
              <span className={styles.value}>{address}</span>
            </div>
          )}
          
          {/* Access info */}
          {access && (
            <div className={styles.detail}>
              <span className={styles.label}>
                <span className={styles.detailIcon}>🚃</span> Access:
              </span>
              <span className={styles.value}>{access}</span>
            </div>
          )}
          
          {/* Opening hours */}
          {openHours && (
            <div className={styles.detail}>
              <span className={styles.label}>
                <span className={styles.detailIcon}>🕐</span> Hours:
              </span>
              <span className={styles.value}>{openHours}</span>
            </div>
          )}
          
          {/* Close days */}
          {closeDays && (
            <div className={styles.detail}>
              <span className={styles.label}>
                <span className={styles.detailIcon}>📅</span> Closed:
              </span>
              <span className={styles.value}>{closeDays}</span>
            </div>
          )}
          
          {/* Capacity */}
          {capacity && (
            <div className={styles.detail}>
              <span className={styles.label}>
                <span className={styles.detailIcon}>👥</span> Capacity:
              </span>
              <span className={styles.value}>{capacity}</span>
            </div>
          )}
          
          {/* Parking info */}
          {parking && (
            <div className={styles.detail}>
              <span className={styles.label}>
                <span className={styles.detailIcon}>🅿️</span> Parking:
              </span>
              <span className={styles.value}>{parking}</span>
            </div>
          )}
          
          {/* Website link */}
          {urlsPc && (
            <div className={styles.link}>
              <a href={urlsPc} target="_blank" rel="noopener noreferrer">
                <span className={styles.linkIcon}>🔗</span> View details
              </a>
            </div>
          )}
        </div>
        <div className={styles.cardActions}>
          <button
            className={`${styles.saveButton} ${isSaved ? styles.saved : ""}`}
            onClick={(e) => { e.stopPropagation(); onSave(); }}
            disabled={isSaved}
            title={isSaved ? "Saved" : "Save to archive"}
          >
            {isSaved ? "✓" : "📚"}
          </button>
          {onDetail && (
            <button
              className={styles.detailButton}
              onClick={(e) => { e.stopPropagation(); onDetail(); }}
              title="View details"
            >
              📋
            </button>
          )}
        </div>
      </div>
      
      {/* Friend appointment buttons */}
      {friendsMatched.length > 0 && (
        <div className={styles.friendsSection}>
          <p className={styles.friendsTitle}>
            <span className={styles.friendsIcon}>👥</span>
            Friends who saved this place:
          </p>
          <div className={styles.friendButtons}>
            {friendsMatched.map((friend) => (
              <button
                key={friend.id}
                className={styles.appointmentButton}
                onClick={() => handleAppointment(friend)}
                title={`Book with ${friend.name}`}
              >
                <span className={styles.appointmentIcon}>📅</span>
                Book with {friend.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
  },
  // Custom comparison to detect friendsMatched changes
  (prev, next) => {
    // Check if friendsMatched array changed
    const friendsChanged = 
      prev.friendsMatched.length !== next.friendsMatched.length ||
      prev.friendsMatched.some((f, i) => f.id !== next.friendsMatched[i]?.id);
    
    return (
      prev.archiveItem.itemId === next.archiveItem.itemId &&
      prev.isSaved === next.isSaved &&
      !friendsChanged  // Re-render if friends changed
      // Skip onSave comparison (function reference changes but behavior is same)
    );
  }
);
