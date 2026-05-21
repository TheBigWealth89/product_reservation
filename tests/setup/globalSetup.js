/**
 * Vitest globalSetup — runs once before all test files.
 * Connects to postgres-test, creates schema, seeds baseline data,
 * and verifies redis-test connectivity.
 *
 * When running unit tests only (no Docker), this gracefully skips
 * DB/Redis setup and logs a warning.
 */
import pg from "pg";
import Redis from "ioredis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env.test specifically for the global setup process
dotenv.config({ path: path.join(__dirname, "../../.env.test") });

export async function setup() {
  // Skip DB/Redis setup if running unit tests only
  const isUnitOnly = process.argv.some((arg) => arg.includes("tests/unit"));

  if (isUnitOnly) {
    console.log("[globalSetup] ⏭ Unit-only run detected — skipping DB/Redis setup");
    return;
  }

  try {
    console.log("[globalSetup] 🐳 Starting Docker containers...");
    execSync("docker compose -f docker-compose.test.yml up -d --wait", { stdio: "inherit" });

    // Connect to postgres-test
    const pool = new pg.Pool({
      host: process.env.DB_HOST || "localhost",
      port: parseInt(process.env.DB_PORT || "5432"),
      user: process.env.DB_USER || "test_user",
      password: process.env.DB_PASSWORD || "test_pass",
      database: process.env.DB_NAME || "reservation_test",
      connectionTimeoutMillis: 5000,
    });

    // Run init.sql to create schema
    const sqlPath = path.join(__dirname, "../../sql/init.sql");
    const initSql = fs.readFileSync(sqlPath, "utf8");

    // Drop existing tables first for a clean slate
    await pool.query("DROP TABLE IF EXISTS orders CASCADE");
    await pool.query("DROP TABLE IF EXISTS products CASCADE");
    await pool.query(initSql);

    console.log("[globalSetup] ✅ Schema created and baseline product seeded");

    // Verify Redis connectivity
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    const redis = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      connectTimeout: 5000,
    });
    const pong = await redis.ping();
    if (pong !== "PONG") {
      throw new Error(`Redis ping failed: ${pong}`);
    }
    console.log("[globalSetup] ✅ Redis connected (PONG received)");

    // Seed baseline Redis inventory for the default product (id=1)
    await redis.set("inventory:product-1", "5");
    console.log("[globalSetup] ✅ Redis inventory seeded for product-1");

    await redis.quit();
    await pool.end();
  } catch (err) {
    console.error("[globalSetup] ⚠️  DB/Redis setup failed:", err.message);
    console.error("[globalSetup] Integration and e2e tests will fail. Unit tests will still pass.");
  }
}

export async function teardown() {
  const isUnitOnly = process.argv.some((arg) => arg.includes("tests/unit"));
  if (!isUnitOnly) {
    console.log("[globalTeardown] 🐳 Tearing down Docker containers...");
    try {
      execSync("docker compose -f docker-compose.test.yml down -v", { stdio: "inherit" });
    } catch (err) {
      console.error("[globalTeardown] ⚠️ Failed to teardown Docker containers:", err.message);
    }
  }
  console.log("[globalTeardown] ✅ Global teardown complete");
}
