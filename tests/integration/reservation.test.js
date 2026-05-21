/**
 * Integration tests for Critical Paths A + B:
 * A — Reservation flow (POST /product/:id/reserve)
 * B — Concurrent reservation (race condition prevention via Lua atomicity)
 */
import { describe, test, expect, beforeEach, afterAll } from "vitest";
import {
  getPool,
  getRedis,
  getRequest,
  loginAs,
  seedProduct,
  getRedisValue,
  getRedisSet,
  getRedisTTL,
  clearRedisKeys,
  closeConnections,
} from "../setup/testHelpers.js";
import jwt from "jsonwebtoken";

const pool = getPool();
const redis = getRedis();
const request = getRequest();

afterAll(async () => {
  await closeConnections();
});

describe("Reservation Flow (Path A)", () => {
  let customerCookie;
  let product;

  beforeEach(async () => {
    // Clean DB state
    await pool.query("TRUNCATE orders CASCADE");
    await pool.query("TRUNCATE products CASCADE");

    // Seed a fresh product
    product = await seedProduct({ inventory: 10 });

    // Seed Redis inventory
    await redis.set(`inventory:product-${product.id}`, "10");

    // Clear any cart keys
    await clearRedisKeys(`cart:user-user-alice`);

    // Get auth cookie
    customerCookie = await loginAs("customer");
  });

  test("successful reservation creates order, updates Redis inventory, sets reservation key", async () => {
    const res = await request
      .post(`/product/${product.id}/reserve`)
      .set("Cookie", customerCookie)
      .expect(200);

    expect(res.body.message).toBe("Reservation successfully");
    expect(res.body.inventory).toBe(9);
    expect(res.body.reservationKey).toBeDefined();

    // DB: order row created with status='reserved'
    const orders = await pool.query("SELECT * FROM orders WHERE product_id = $1", [product.id]);
    expect(orders.rows).toHaveLength(1);
    expect(orders.rows[0].status).toBe("reserved");
    expect(orders.rows[0].user_id).toBe("user-alice");

    // Redis: inventory decremented
    const inv = await getRedisValue(`inventory:product-${product.id}`);
    expect(inv).toBe("9");

    // Redis: reservation key exists with TTL
    const ttl = await getRedisTTL(res.body.reservationKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);

    // Redis: cart contains entry
    const cart = await getRedisSet("cart:user-user-alice");
    expect(cart.length).toBe(1);
  });

  test("out of stock returns 400 and does not create order", async () => {
    // Set inventory to 0
    await redis.set(`inventory:product-${product.id}`, "0");

    const res = await request
      .post(`/product/${product.id}/reserve`)
      .set("Cookie", customerCookie)
      .expect(400);

    expect(res.body.error).toBe("Out of stock");

    // DB: no orders created
    const orders = await pool.query("SELECT * FROM orders WHERE product_id = $1", [product.id]);
    expect(orders.rows).toHaveLength(0);

    // Redis: inventory still 0
    const inv = await getRedisValue(`inventory:product-${product.id}`);
    expect(inv).toBe("0");
  });

  test("missing authentication returns 401 or redirects", async () => {
    const res = await request
      .post(`/product/${product.id}/reserve`)
      .set("Accept", "application/json");

    // Without cookie, should get 401 or 302
    expect([302, 401]).toContain(res.status);
  });
});

describe("Concurrent Reservation — Lua Atomicity (Path B)", () => {
  let product;

  beforeEach(async () => {
    await pool.query("TRUNCATE orders CASCADE");
    await pool.query("TRUNCATE products CASCADE");

    // Seed product with inventory=3
    product = await seedProduct({ inventory: 3 });
    await redis.set(`inventory:product-${product.id}`, "3");

    // Clear all test user carts and any rate limit keys
    for (let i = 1; i <= 6; i++) {
      await clearRedisKeys(`cart:user-user-${i}`);
    }
  });

  test("6 concurrent reservations with inventory=3: exactly 3 succeed, 3 fail, inventory=0", async () => {
    // Generate 6 distinct user JWTs
    const tokens = [];
    for (let i = 1; i <= 6; i++) {
      const token = jwt.sign(
        { sub: `user-${i}`, role: "customer" },
        process.env.JWT_SECRET || "test-jwt-secret-not-for-production",
        { expiresIn: "1h" }
      );
      tokens.push(`token=${token}`);
    }

    // Fire all 6 requests simultaneously
    const results = await Promise.all(
      tokens.map((cookie) =>
        request
          .post(`/product/${product.id}/reserve`)
          .set("Cookie", cookie)
      )
    );

    const successes = results.filter((r) => r.status === 200);
    const failures = results.filter((r) => r.status === 400);

    // Exactly 3 succeed, exactly 3 fail
    expect(successes).toHaveLength(3);
    expect(failures).toHaveLength(3);

    // Redis inventory must be exactly 0 (never negative)
    const inv = await getRedisValue(`inventory:product-${product.id}`);
    expect(inv).toBe("0");

    // DB must have exactly 3 reserved orders
    const orders = await pool.query(
      "SELECT * FROM orders WHERE product_id = $1 AND status = 'reserved'",
      [product.id]
    );
    expect(orders.rows).toHaveLength(3);
  });

  test("inventory floor at zero — inventory never goes negative", async () => {
    // Set inventory to 1
    await redis.set(`inventory:product-${product.id}`, "1");

    const tokens = [];
    for (let i = 1; i <= 3; i++) {
      const token = jwt.sign(
        { sub: `user-floor-${i}`, role: "customer" },
        process.env.JWT_SECRET || "test-jwt-secret-not-for-production",
        { expiresIn: "1h" }
      );
      tokens.push(`token=${token}`);
    }

    await Promise.all(
      tokens.map((cookie) =>
        request
          .post(`/product/${product.id}/reserve`)
          .set("Cookie", cookie)
      )
    );

    // Redis inventory must be 0, never negative
    const inv = await getRedisValue(`inventory:product-${product.id}`);
    expect(parseInt(inv)).toBeGreaterThanOrEqual(0);
  });
});
