import "./config/loadEnv.js";
import { createClient } from "redis";
import { Pool } from "pg";
import logger from "./utils/logger.js";

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

// --- Central Connect Function ---
let isConnected = false;
export async function connectAll() {
  if (isConnected) return; // Prevent connecting multiple times

  logger.info("🚀 Initializing all connections...");
  await pool.connect();
  logger.info("✅ PostgreSQL connected.");
  await redisClient.connect();
  logger.info("✅ Redis connected.");
  isConnected = true;
}