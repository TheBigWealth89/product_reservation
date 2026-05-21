/**
 * Test helpers shared across all test files.
 * Provides utilities for auth, seeding, and Redis assertions.
 */
import pg from "pg";
import Redis from "ioredis";
import supertest from "supertest";
import app from "../../src/app.js";

// --- Shared connections (created once per test worker process) ---

let _pool;
let _redis;

export function getPool() {
  if (!_pool) {
    _pool = new pg.Pool({
      host: process.env.DB_HOST || "localhost",
      port: parseInt(process.env.DB_PORT || "5432"),
      user: process.env.DB_USER || "test_user",
      password: process.env.DB_PASSWORD || "test_pass",
      database: process.env.DB_NAME || "reservation_test",
      max: process.env.NODE_ENV === "test" ? 2 : 5,
    });
  }
  return _pool;
}

export function getRedis() {
  if (!_redis) {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    _redis = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
  return _redis;
}

export function getRequest() {
  return supertest(app);
}

export async function closeConnections() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}

// --- Auth helpers ---

/**
 * Logs in as a given role and returns the cookie string for supertest.
 * @param {'customer'|'admin'} role
 * @returns {Promise<string>} Cookie string like "token=xxx"
 */
export async function loginAs(role) {
  const credentials =
    role === "admin"
      ? { username: "admin", password: "adminpass" }
      : { username: "alice", password: "pass123" };

  const res = await getRequest()
    .post("/login")
    .send(credentials)
    .expect(302);

  // Extract the set-cookie header
  const cookies = res.headers["set-cookie"];
  if (!cookies) {
    throw new Error(`loginAs(${role}) failed: no set-cookie header`);
  }
  // Return the cookie string that supertest can use
  const tokenCookie = Array.isArray(cookies)
    ? cookies.find((c) => c.startsWith("token="))
    : cookies;
  return tokenCookie;
}

// --- Seeding helpers ---

/**
 * Seeds a product row into the database.
 * @param {object} overrides - Fields to override defaults
 * @returns {Promise<object>} The inserted product row
 */
export async function seedProduct(overrides = {}) {
  const pool = getPool();
  const defaults = {
    name: "Test Product",
    description: "A test product",
    price: 100.0,
    inventory: 5,
  };
  const p = { ...defaults, ...overrides };
  const result = await pool.query(
    "INSERT INTO products (name, description, price, inventory) VALUES ($1, $2, $3, $4) RETURNING *",
    [p.name, p.description, p.price, p.inventory]
  );
  return result.rows[0];
}

/**
 * Seeds an order row into the database.
 * @param {object} overrides - Fields to override defaults
 * @returns {Promise<object>} The inserted order row
 */
export async function seedOrder(overrides = {}) {
  const pool = getPool();
  const defaults = {
    product_id: 1,
    user_id: "user-alice",
    status: "reserved",
    reservation_id: `1:rev-test-${Date.now()}`,
    amount: 100.0,
    expires_at: new Date(Date.now() + 600000), // 10 min from now
  };
  const o = { ...defaults, ...overrides };
  const result = await pool.query(
    `INSERT INTO orders (product_id, user_id, status, reservation_id, amount, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [o.product_id, o.user_id, o.status, o.reservation_id, o.amount, o.expires_at]
  );
  return result.rows[0];
}

// --- Redis assertion helpers ---

export async function getRedisValue(key) {
  return getRedis().get(key);
}

export async function getRedisSet(key) {
  return getRedis().smembers(key);
}

export async function getRedisTTL(key) {
  return getRedis().ttl(key);
}

/**
 * Deletes specific Redis keys. Never uses FLUSHALL.
 * @param  {...string} keys - Redis keys to delete
 */
export async function clearRedisKeys(...keys) {
  if (keys.length === 0) return;
  return getRedis().del(...keys);
}
