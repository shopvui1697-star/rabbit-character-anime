import { pool } from "./connection.js";
import type {
  ConversationTurn,
  ConversationHistoryRecord,
  DomainType,
} from "../types/index.js";

/**
 * Save a conversation turn to the database
 */
export async function saveConversationTurn(
  sessionId: string,
  turn: ConversationTurn,
  domain: DomainType = "movie",
  userId?: string,
  userName?: string,
  userToken?: string
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO conversation_history (session_id, user_id, user_name, user_token, role, content, domain, emotion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, userId || null, userName || null, userToken || null, turn.role, turn.content, domain, turn.emotion || null]
    );
  } catch (error) {
    console.error("Failed to save conversation turn:", error);
    throw error;
  }
}

/**
 * Get conversation history for a session
 */
export async function getConversationHistory(
  sessionId: string,
  domain?: DomainType,
  limit: number = 50
): Promise<ConversationHistoryRecord[]> {
  try {
    let query = `
      SELECT id, session_id, user_id, user_name, user_token, role, content, domain, emotion, created_at
      FROM conversation_history
      WHERE session_id = ?
    `;
    const params: (string | number)[] = [sessionId];

    // Filter by domain if specified
    if (domain) {
      query += ` AND domain = ?`;
      params.push(domain);
    }

    query += ` ORDER BY created_at ASC LIMIT ?`;
    params.push(limit);

    const result = await pool.query(query, params);
    return result.rows;
  } catch (error) {
    console.error("Failed to get conversation history:", error);
    throw error;
  }
}

/**
 * Convert database records to conversation turns
 */
export function recordsToTurns(
  records: ConversationHistoryRecord[]
): ConversationTurn[] {
  return records.map((record) => ({
    role: record.role,
    content: record.content,
    domain: record.domain,
    emotion: record.emotion as any,
  }));
}

/**
 * Get recent conversation history across all sessions by domain
 */
export async function getRecentHistoryByDomain(
  domain: DomainType,
  limit: number = 100
): Promise<ConversationHistoryRecord[]> {
  try {
    const result = await pool.query(
      `SELECT id, session_id, user_id, user_name, user_token, role, content, domain, emotion, created_at
       FROM conversation_history
       WHERE domain = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [domain, limit]
    );
    return result.rows;
  } catch (error) {
    console.error("Failed to get recent history by domain:", error);
    throw error;
  }
}

/**
 * Delete old conversation history
 */
export async function deleteOldHistory(daysOld: number = 30): Promise<number> {
  try {
    const result = await pool.query(
      `DELETE FROM conversation_history
       WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [daysOld]
    );
    return result.rowCount || 0;
  } catch (error) {
    console.error("Failed to delete old history:", error);
    throw error;
  }
}

/**
 * Get conversation statistics by domain
 */
export async function getConversationStats(): Promise<{
  [domain: string]: { total: number; sessions: number };
}> {
  try {
    const result = await pool.query(
      `SELECT 
         domain,
         COUNT(*) as total,
         COUNT(DISTINCT session_id) as sessions
       FROM conversation_history
       GROUP BY domain
       ORDER BY total DESC`
    );

    const stats: { [domain: string]: { total: number; sessions: number } } = {};
    for (const row of result.rows) {
      stats[row.domain] = {
        total: parseInt(row.total, 10),
        sessions: parseInt(row.sessions, 10),
      };
    }
    return stats;
  } catch (error) {
    console.error("Failed to get conversation stats:", error);
    throw error;
  }
}

/**
 * Get conversation history for a specific user
 */
export async function getConversationHistoryByUserId(
  userId: string,
  domain?: DomainType,
  limit: number = 50
): Promise<ConversationHistoryRecord[]> {
  try {
    let query = `
      SELECT id, session_id, user_id, user_name, user_token, role, content, domain, emotion, created_at
      FROM conversation_history
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
    console.error("Failed to get conversation history by user ID:", error);
    throw error;
  }
}

/**
 * Get unique users from conversation history
 */
export async function getUniqueUsers(): Promise<Array<{
  user_id: string;
  user_name?: string;
  message_count: number;
  last_activity: Date;
}>> {
  try {
    const result = await pool.query(
      `SELECT 
         user_id,
         user_name,
         COUNT(*) as message_count,
         MAX(created_at) as last_activity
       FROM conversation_history
       WHERE user_id IS NOT NULL
       GROUP BY user_id, user_name
       ORDER BY last_activity DESC`
    );
    return result.rows;
  } catch (error) {
    console.error("Failed to get unique users:", error);
    throw error;
  }
}
