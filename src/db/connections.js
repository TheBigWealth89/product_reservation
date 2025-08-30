import "../config/loadEnv.js";
import Redis from "ioredis";
import { Pool } from "pg";
import logger from "../utils/logger.js";
// --- PostgreSQL Connection ---
export const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },
});

// --- Redis Connection ---
const redisUrl = process.env.REDIS_URL;
export const redisClient = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  rejectUnauthorized: true,
  tls: redisUrl.startsWith("rediss//")
    ? { rejectUnauthorized: false }
    : undefined,
});
// --- Connection Event Listeners ---
pool.on("connect", () => logger.info("PostgreSQL client acquired"));
pool.on("error", (err) => logger.error("PostgreSQL pool error:", err));

redisClient.on("connect", () =>
  logger.info(`Redis connecting......... ${redisUrl}`)
);
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
    //Checking status because ioredis connects automatically
    if (redisClient.status !== "ready") {
      logger.info("⏳ Waiting for Redis connection...");
    }
    logger.info("✅ Redis connected.");
    isConnected = true;
  } catch (err) {
    isConnected = false;
    throw err;
  }
}
