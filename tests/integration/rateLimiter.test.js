/**
 * Integration tests for Critical Path H:
 * Rate limiting — under limit, at limit, over limit returns 429.
 */
import { describe, test, expect, beforeEach, afterAll } from "vitest";
import {
  getPool,
  getRedis,
  getRequest,
  seedProduct,
  clearRedisKeys,
  closeConnections,
} from "../setup/testHelpers.js";
import jwt from "jsonwebtoken";

const pool = getPool();
const redis = getRedis();
const request = getRequest();

describe("Rate Limiting (Path H)", () => {
  let product;
  let userCookie;

  beforeEach(async () => {
    await pool.query("TRUNCATE orders CASCADE");
    await pool.query("TRUNCATE products CASCADE");

    product = await seedProduct({ inventory: 100 }); // high inventory so rate limit is hit before stock
    await redis.set(`inventory:product-${product.id}`, "100");

    // Use a unique user per test run to avoid cross-test rate limit pollution
    const userId = `rate-user-${Date.now()}`;
    const token = jwt.sign(
      { sub: userId, role: "customer" },
      process.env.JWT_SECRET || "test-jwt-secret-not-for-production",
      { expiresIn: "1h" }
    );
    userCookie = `token=${token}`;

    // Clean any rate limit keys for this user
    // rate-limit-redis uses keys like rl:... — we clean by pattern
    const keys = await redis.keys(`rl:*`);
    if (keys.length > 0) {
      await clearRedisKeys(...keys);
    }
  });

  afterAll(async () => {
    await closeConnections();
  });

  test("first request under limit returns 200", async () => {
    const res = await request
      .post(`/product/${product.id}/reserve`)
      .set("Cookie", userCookie);

    expect(res.status).toBe(200);
  });

  test("10 requests at limit all succeed", async () => {
    const results = [];
    for (let i = 0; i < 10; i++) {
      const res = await request
        .post(`/product/${product.id}/reserve`)
        .set("Cookie", userCookie);
      results.push(res.status);
    }

    // All 10 should be 200 (reserve limiter allows 10 per 15 min)
    expect(results.every((s) => s === 200)).toBe(true);
  });

  test("11th request over limit returns 429 with retryAfter", async () => {
    // Fire 10 requests to exhaust the limit
    for (let i = 0; i < 10; i++) {
      await request
        .post(`/product/${product.id}/reserve`)
        .set("Cookie", userCookie);
    }

    // 11th request should be rate limited
    const res = await request
      .post(`/product/${product.id}/reserve`)
      .set("Cookie", userCookie);

    expect(res.status).toBe(429);
    expect(res.body.retryAfter).toBeDefined();
    expect(res.body.retryAfter).toBeGreaterThan(0);
  });
});
