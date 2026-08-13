import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { config, validateConfig } from "./config/index.js";
import { handleConnection, getSessionCount } from "./websocket/handler.js";
import { testConnection } from "./db/connection.js";
import { logger } from "./utils/logger.js";
import { 
  saveToArchive, 
  removeFromArchive, 
  getArchiveByDomain, 
  isInArchive,
  getFriendsWhoSavedItem
} from "./db/user-archive.js";
import type { DomainType } from "./types/index.js";
import transcribeRouter from "./routes/transcribe.js";

// Validate configuration
validateConfig();

// Create Express app
const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

// Health check endpoint
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    activeSessions: getSessionCount(),
  });
});

// API info endpoint
app.get("/api", (_req, res) => {
  res.json({
    name: "Rabbit AI Avatar API",
    version: "1.0.0",
    endpoints: {
      health: "/health",
      websocket: "/ws",
      transcribe: {
        stsToken: "GET /api/transcribe/sts-token",
        health: "GET /api/transcribe/health",
      },
      archive: {
        save: "POST /api/archive",
        remove: "DELETE /api/archive",
        list: "GET /api/archive/:userId",
        check: "GET /api/archive/:userId/:domain/:itemId",
      },
    },
  });
});

// Mount transcribe routes
app.use("/api/transcribe", transcribeRouter);

// Archive API endpoints

/**
 * Save item to user's archive
 * POST /api/archive
 * Body: { userId, domain, itemId, itemTitle?, itemData? }
 */
app.post("/api/archive", async (req, res) => {
  try {
    const { userId, domain, itemId, itemTitle, itemData } = req.body;

    if (!userId || !domain || !itemId) {
      return res.status(400).json({ 
        error: "Missing required fields: userId, domain, itemId" 
      });
    }

    // Validate domain
    if (!["movie", "gourmet", "general"].includes(domain)) {
      return res.status(400).json({ 
        error: "Invalid domain. Must be 'movie', 'gourmet', or 'general'" 
      });
    }

    // Save to archive
    const result = await saveToArchive(userId, domain as DomainType, itemId, itemTitle, itemData);
    
    // Get friends who also saved this item
    const friendsMatched = await getFriendsWhoSavedItem(userId, domain as DomainType, itemId);
    
    logger.info(`Item saved to archive: user=${userId}, domain=${domain}, itemId=${itemId}, friendsMatched=${friendsMatched.length}`);
    
    res.json({
      success: true,
      message: "Item saved to archive",
      archive: result,
      friends_matched: friendsMatched,
    });
  } catch (error) {
    logger.error("Archive save error: " + (error instanceof Error ? error.message : String(error)));
    res.status(500).json({ 
      error: "Failed to save to archive" 
    });
  }
});

/**
 * Remove item from user's archive
 * DELETE /api/archive
 * Body: { userId, domain, itemId }
 */
app.delete("/api/archive", async (req, res) => {
  try {
    const { userId, domain, itemId } = req.body;

    if (!userId || !domain || !itemId) {
      return res.status(400).json({ 
        error: "Missing required fields: userId, domain, itemId" 
      });
    }

    const removed = await removeFromArchive(userId, domain as DomainType, itemId);
    
    if (removed) {
      logger.info(`Item removed from archive: user=${userId}, domain=${domain}, itemId=${itemId}`);
      res.json({
        success: true,
        message: "Item removed from archive",
      });
    } else {
      res.status(404).json({
        error: "Item not found in archive",
      });
    }
  } catch (error) {
    logger.error("Archive remove error: " + (error instanceof Error ? error.message : String(error)));
    res.status(500).json({ 
      error: "Failed to remove from archive" 
    });
  }
});

/**
 * Get user's archive items
 * GET /api/archive/:userId?domain=movie&limit=100
 */
app.get("/api/archive/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const domain = req.query.domain as DomainType | undefined;
    const limit = parseInt(req.query.limit as string) || 100;

    if (!userId) {
      return res.status(400).json({ 
        error: "Missing userId" 
      });
    }

    const archives = await getArchiveByDomain(userId, domain, limit);
    
    res.json({
      success: true,
      archives,
      count: archives.length,
    });
  } catch (error) {
    logger.error("Archive list error: " + (error instanceof Error ? error.message : String(error)));
    res.status(500).json({ 
      error: "Failed to get archive" 
    });
  }
});

/**
 * Check if item is in user's archive
 * GET /api/archive/:userId/:domain/:itemId
 */
app.get("/api/archive/:userId/:domain/:itemId", async (req, res) => {
  try {
    const { userId, domain, itemId } = req.params;

    if (!userId || !domain || !itemId) {
      return res.status(400).json({ 
        error: "Missing required parameters" 
      });
    }

    const inArchive = await isInArchive(userId, domain as DomainType, itemId);
    
    res.json({
      success: true,
      inArchive,
    });
  } catch (error) {
    logger.error("Archive check error: " + (error instanceof Error ? error.message : String(error)));
    res.status(500).json({ 
      error: "Failed to check archive" 
    });
  }
});

// Create HTTP server
const server = createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ 
  server,
  path: "/ws",
});

// Handle WebSocket connections
wss.on("connection", (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  logger.info(`New WebSocket connection from ${clientIp}`);
  handleConnection(ws);
});

// Start server
async function start() {
  logger.info("Starting Rabbit AI Avatar Server...");
  logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Test database connection
  const dbConnected = await testConnection();
  if (!dbConnected) {
    logger.warn("Database not available. User profile, conversation history, and archive will not work.");
    logger.warn("Run 'npm run db:setup' after setting up MySQL.");
  }

  // Start HTTP server
  server.listen(config.port, () => {
    // Always show these logs (not through logger to ensure visibility)
    console.log("\n" + "=".repeat(70));
    console.log("🐰 Rabbit AI Backend Server - READY");
    console.log("=".repeat(70));
    console.log(`📡 Port:           ${config.port}`);
    console.log(`🔌 WebSocket:      ws://localhost:${config.port}/ws`);
    console.log(`🏥 Health Check:   http://localhost:${config.port}/health`);
    console.log(`🌐 CORS Origin:    ${config.corsOrigin}`);
    console.log(`🐛 Debug Mode:     ${process.env.DEBUG === "true" ? "✅ ENABLED" : "❌ DISABLED"}`);
    console.log(`📁 Logs Directory: backend/logs/`);
    console.log(`📝 Log Format:     userid-{userId}.log (appends automatically)`);
    console.log("\n💡 Log Files Created When:");
    console.log("   1. WebSocket connection established");
    console.log("   2. User sends first message");
    console.log("   3. Before auth → userid-guest.log");
    console.log("   4. After auth  → userid-{actual-id}.log");
    console.log("\n📊 Watch Logs:");
    console.log("   tail -f backend/logs/userid-*.log");
    console.log("=".repeat(70) + "\n");
    
    // Also log through logger system
    logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    logger.info(`Server running on http://localhost:${config.port}`);
    logger.info(`WebSocket available at ws://localhost:${config.port}/ws`);
    logger.info(`CORS origin: ${config.corsOrigin}`);
    logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    logger.info("Ready to accept connections!");
  });
}

// Handle graceful shutdown
process.on("SIGTERM", () => {
  logger.info("Shutting down gracefully...");
  wss.close();
  server.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  logger.info("Shutting down gracefully...");
  wss.close();
  server.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });
});

// Start the server
start().catch((error) => {
  logger.error("Failed to start server", error);
  process.exit(1);
});
