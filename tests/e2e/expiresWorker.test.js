/**
 * E2E tests for Critical Path F:
 * Expiry processor — expires reserved orders, restores stock,
 * leaves payment_pending orders untouched.
 */
import { describe, test, expect, beforeEach, afterAll } from "vitest";
import {
  getPool,
  getRedis,
  seedProduct,
  seedOrder,
  getRedisValue,
  getRedisSet,
  closeConnections,
} from "../setup/testHelpers.js";
import { expiryProcessor } from "../../src/workers/processors/expiry.processor.js";

const pool = getPool();
const redis = getRedis();

describe("Expiry Processor (Path F)", () => {
  let product;

  beforeEach(async () => {
    await pool.query("TRUNCATE orders CASCADE");
    await pool.query("TRUNCATE products CASCADE");
    product = await seedProduct({ inventory: 5 });
    await redis.set(`inventory:product-${product.id}`, "0"); // simulating all reserved
  });

  afterAll(async () => {
    await closeConnections();
  });

  test("expired reserved order: status becomes expired, stock restored, cart cleaned", async () => {
    const pastDate = new Date(Date.now() - 3600000); // 1 hour ago
    const reservationId = `${product.id}:rev-expiry-1`;
    const order = await seedOrder({
      product_id: product.id,
      user_id: "user-alice",
      status: "reserved",
      reservation_id: reservationId,
      expires_at: pastDate,
    });

    // Set up Redis cart
    await redis.sadd("cart:user-user-alice", reservationId);

    await expiryProcessor();

    // DB: order status = 'expired'
    const orderResult = await pool.query("SELECT status FROM orders WHERE id = $1", [order.id]);
    expect(orderResult.rows[0].status).toBe("expired");

    // Redis: inventory restored by 1 (was 0, now 1)
    const inv = await getRedisValue(`inventory:product-${product.id}`);
    expect(inv).toBe("1");

    // Redis: cart entry removed
    const cart = await getRedisSet("cart:user-user-alice");
    expect(cart).not.toContain(reservationId);
  });

  test("payment_pending order is NOT expired even if expires_at is past", async () => {
    const pastDate = new Date(Date.now() - 3600000);
    const order = await seedOrder({
      product_id: product.id,
      user_id: "user-bob",
      status: "payment_pending",
      reservation_id: `${product.id}:rev-expiry-pp`,
      expires_at: pastDate,
    });

    await expiryProcessor();

    // DB: order status still 'payment_pending'
    const orderResult = await pool.query("SELECT status FROM orders WHERE id = $1", [order.id]);
    expect(orderResult.rows[0].status).toBe("payment_pending");
  });

  test("stock restored correctly in Redis after expiry", async () => {
    const pastDate = new Date(Date.now() - 3600000);
    await seedOrder({
      product_id: product.id,
      user_id: "user-restore",
      status: "reserved",
      reservation_id: `${product.id}:rev-expiry-restore`,
      expires_at: pastDate,
    });

    // Redis inventory starts at 0
    expect(await getRedisValue(`inventory:product-${product.id}`)).toBe("0");

    await expiryProcessor();

    // Redis inventory restored to 1
    expect(await getRedisValue(`inventory:product-${product.id}`)).toBe("1");
  });

  test("cart entry removed after expiry", async () => {
    const pastDate = new Date(Date.now() - 3600000);
    const reservationId = `${product.id}:rev-expiry-cart`;
    await seedOrder({
      product_id: product.id,
      user_id: "user-cart-test",
      status: "reserved",
      reservation_id: reservationId,
      expires_at: pastDate,
    });
    await redis.sadd("cart:user-user-cart-test", reservationId);

    await expiryProcessor();

    const isMember = await redis.sismember("cart:user-user-cart-test", reservationId);
    expect(isMember).toBe(0);
  });
});
