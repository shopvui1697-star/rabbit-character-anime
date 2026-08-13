import { pool } from "./connection.js";
import type { DomainType } from "../types/index.js";

/**
 * User archive interface matching database schema
 */
export interface UserArchive {
  id: number;
  user_id: string;
  domain: DomainType;
  item_id: string;
  item_title?: string;
  item_data?: Record<string, unknown>;
  created_at: Date;
}

/**
 * Save item to user's archive
 */
export async function saveToArchive(
  userId: string,
  domain: DomainType,
  itemId: string,
  itemTitle?: string,
  itemData?: Record<string, unknown>
): Promise<UserArchive> {
  try {
    // MySQL has no RETURNING clause — upsert, then re-select the row by its unique key
    await pool.query(
      `INSERT INTO user_archive (user_id, domain, item_id, item_title, item_data)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         item_title = VALUES(item_title),
         item_data = VALUES(item_data),
         created_at = CURRENT_TIMESTAMP`,
      [userId, domain, itemId, itemTitle || null, itemData ? JSON.stringify(itemData) : null]
    );

    const result = await pool.query<UserArchive>(
      `SELECT * FROM user_archive WHERE user_id = ? AND domain = ? AND item_id = ?`,
      [userId, domain, itemId]
    );

    return result.rows[0];
  } catch (error) {
    console.error("Failed to save to archive:", error);
    throw error;
  }
}

/**
 * Remove item from user's archive
 */
export async function removeFromArchive(
  userId: string,
  domain: DomainType,
  itemId: string
): Promise<boolean> {
  try {
    const result = await pool.query(
      `DELETE FROM user_archive
       WHERE user_id = ? AND domain = ? AND item_id = ?`,
      [userId, domain, itemId]
    );

    return (result.rowCount || 0) > 0;
  } catch (error) {
    console.error("Failed to remove from archive:", error);
    throw error;
  }
}

/**
 * Get user's archive items by domain
 */
export async function getArchiveByDomain(
  userId: string,
  domain?: DomainType,
  limit: number = 100
): Promise<UserArchive[]> {
  try {
    let query = `
      SELECT id, user_id, domain, item_id, item_title, item_data, created_at
      FROM user_archive
      WHERE user_id = ?
    `;
    const params: (string | number)[] = [userId];

    // Filter by domain if specified
    if (domain) {
      query += ` AND domain = ?`;
      params.push(domain);
    }

    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const result = await pool.query(query, params);
    return result.rows;
  } catch (error) {
    console.error("Failed to get archive by domain:", error);
    throw error;
  }
}

/**
 * Check if item is in user's archive
 */
export async function isInArchive(
  userId: string,
  domain: DomainType,
  itemId: string
): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT 1 FROM user_archive
       WHERE user_id = ? AND domain = ? AND item_id = ?
       LIMIT 1`,
      [userId, domain, itemId]
    );

    return result.rows.length > 0;
  } catch (error) {
    console.error("Failed to check archive:", error);
    throw error;
  }
}

/**
 * Get archive statistics for user
 */
export async function getArchiveStats(userId: string): Promise<{
  [domain: string]: number;
}> {
  try {
    const result = await pool.query(
      `SELECT domain, COUNT(*) as count
       FROM user_archive
       WHERE user_id = ?
       GROUP BY domain
       ORDER BY count DESC`,
      [userId]
    );

    const stats: { [domain: string]: number } = {};
    for (const row of result.rows) {
      stats[row.domain] = parseInt(row.count, 10);
    }
    return stats;
  } catch (error) {
    console.error("Failed to get archive stats:", error);
    throw error;
  }
}

/**
 * Friend match interface
 */
export interface FriendMatch {
  id: string;
  name: string;
}

/**
 * Get friends who also saved the same item
 * Returns list of friends (excluding the current user) who have saved this item
 */
export async function getFriendsWhoSavedItem(
  userId: string,
  domain: DomainType,
  itemId: string
): Promise<FriendMatch[]> {
  try {
    const result = await pool.query(
      `SELECT DISTINCT
         ua.user_id as id,
         COALESCE(up.nick_name, up.name, CONCAT('User ', ua.user_id)) as name
       FROM user_archive ua
       LEFT JOIN user_profile up ON CAST(ua.user_id AS SIGNED) = up.users_id
       WHERE ua.domain = ?
         AND ua.item_id = ?
         AND ua.user_id != ?
       ORDER BY name`,
      [domain, itemId, userId]
    );

    return result.rows;
  } catch (error) {
    console.error("Failed to get friends who saved item:", error);
    // Return empty array on error instead of throwing
    // This is a non-critical feature
    return [];
  }
}
