import "../config/loadEnv.js";
import { createClient } from "redis";
import { Pool } from "pg";
import logger from "../utils/logger.js";

// --- PostgreSQL Connection ---
export const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
});

// --- Redis Connection ---
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
export const redisClient = createClient({ url: redisUrl });
// --- Connection Event Listeners ---
pool.on("connect", () => logger.info("PostgreSQL client acquired"));
pool.on("error", (err) => logger.error("PostgreSQL pool error:", err));
redisClient.on("connect", () => logger.info(`Redis connected: ${redisUrl}`));
redisClient.on("ready", () => logger.info("Redis client ready"));
redisClient.on("error", (err) => logger.error("Redis error:", err));
redisClient.on("end", () => logger.warn("Redis connection closed"));

// --- Central Connect Function ---
let isConnected = false;
export async function connectAll() {
  if (isConnected) return; // Prevent connecting multiple times

  try {
    logger.info("🚀 Initializing all connections...");

    await pool.connect();
    logger.info("✅ PostgreSQL connected.");

    if (!redisClient.isReady) {
      await redisClient.connect();
    }
    logger.info("✅ Redis connected.");

    isConnected = true;
  } catch (err) {
    isConnected = false;
    throw err;
  }
}
