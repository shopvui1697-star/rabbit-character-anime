import { pool, closePool } from "./connection.js";

/**
 * Create database schema (MySQL)
 *
 * Indexes are declared inline in each CREATE TABLE so a single
 * `CREATE TABLE IF NOT EXISTS` stays idempotent — MySQL has no
 * `CREATE INDEX IF NOT EXISTS`, so re-running this against an
 * already-set-up database would otherwise fail on duplicate index names.
 */
async function setup() {
  console.log("🔧 Setting up database...");

  try {
    // Create conversation_history table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversation_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(255) NOT NULL,
        user_id VARCHAR(255),
        user_name VARCHAR(255),
        user_token TEXT,
        role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        domain VARCHAR(50) NOT NULL DEFAULT 'movie',
        emotion VARCHAR(20),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_conversation_session_id (session_id),
        INDEX idx_conversation_user_id (user_id),
        INDEX idx_conversation_domain (domain),
        INDEX idx_conversation_created_at (created_at DESC),
        INDEX idx_conversation_session_domain (session_id, domain),
        INDEX idx_conversation_user_domain (user_id, domain)
      )
    `);
    console.log("✅ Created conversation_history table");

    // Create user_profile table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_profile (
        id INT AUTO_INCREMENT PRIMARY KEY,
        users_id INT NOT NULL UNIQUE,
        name VARCHAR(255),
        contact_email_address VARCHAR(255),
        nick_name VARCHAR(255),
        birthday DATE,
        gender VARCHAR(50),
        nationality VARCHAR(100),
        prefecture VARCHAR(100),
        district VARCHAR(100),
        image_url VARCHAR(500),
        is_feature INT,
        introduction TEXT,
        twitter_url VARCHAR(500),
        instagram_url VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP NULL,
        is_push INT DEFAULT 1,
        facebook_url VARCHAR(500),
        read_nickname VARCHAR(255),
        first_setup_notice INT DEFAULT 0,
        user_search TEXT,
        province VARCHAR(100),
        INDEX idx_user_profile_users_id (users_id),
        INDEX idx_user_profile_email (contact_email_address),
        INDEX idx_user_profile_nick_name (nick_name),
        INDEX idx_user_profile_created_at (created_at DESC)
      )
    `);
    console.log("✅ Created user_profile table");

    // Create user_archive table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_archive (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        domain VARCHAR(50) NOT NULL CHECK (domain IN ('movie', 'gourmet', 'general')),
        item_id VARCHAR(255) NOT NULL,
        item_title VARCHAR(500),
        item_data JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_user_domain_item (user_id, domain, item_id),
        INDEX idx_user_archive_user_id (user_id),
        INDEX idx_user_archive_domain (domain),
        INDEX idx_user_archive_user_domain (user_id, domain),
        INDEX idx_user_archive_created_at (created_at DESC)
      )
    `);
    console.log("✅ Created user_archive table");

    console.log("🎉 Database setup complete!");
  } catch (error) {
    console.error("❌ Setup failed:", error);
    throw error;
  } finally {
    await closePool();
  }
}

// Run setup
setup().catch(console.error);
