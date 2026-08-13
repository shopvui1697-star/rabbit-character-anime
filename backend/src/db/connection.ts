import mysql from "mysql2/promise";
import { config } from "../config/index.js";

const rawPool = mysql.createPool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.database,
  user: config.database.user,
  password: config.database.password,
  ssl: config.database.ssl ? { rejectUnauthorized: false } : undefined,
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 2000,
});

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

/**
 * Thin adapter over mysql2's [rows, fields] tuple so call sites can keep using
 * the `{ rows, rowCount }` shape (same as the previous `pg`-based pool).
 */
export const pool = {
  async query<T = any>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
    const [result] = await rawPool.query(sql, params as any[]);
    if (Array.isArray(result)) {
      return { rows: result as T[], rowCount: result.length };
    }
    // INSERT/UPDATE/DELETE return a ResultSetHeader, not a row array
    const header = result as mysql.ResultSetHeader;
    return { rows: [] as T[], rowCount: header.affectedRows ?? 0 };
  },
};

// Test connection
export async function testConnection(): Promise<boolean> {
  try {
    const connection = await rawPool.getConnection();
    await connection.query("SELECT 1");
    connection.release();
    console.log("✅ Database connection successful");
    return true;
  } catch (error) {
    console.error("❌ Database connection failed:", error);
    return false;
  }
}

// Graceful shutdown
export async function closePool(): Promise<void> {
  await rawPool.end();
  console.log("Database pool closed");
}
