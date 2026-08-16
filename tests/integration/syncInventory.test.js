/**
 * Integration tests for syncInventoryToRedis:
 * Verifies single-query aggregated inventory calculation for reserved & payment_pending orders,
 * Redis key update, and Pub/Sub channel publishing.
 */
import { describe, test, expect, beforeEach, afterAll, vi } from "vitest";
import {
  getPool,
  getRedis,
  seedProduct,
  seedOrder,
  getRedisValue,
  closeConnections,
} from "../setup/testHelpers.js";
import { syncInventoryToRedis } from "../../src/db/sync-inventory.js";

const pool = getPool();
const redis = getRedis();

describe("syncInventoryToRedis", () => {
  let product1;
  let product2;

  beforeEach(async () => {
    await pool.query("TRUNCATE orders CASCADE");
    await pool.query("TRUNCATE products CASCADE");
    await redis.flushdb();

    product1 = await seedProduct({ name: "Prod 1", inventory: 10 });
    product2 = await seedProduct({ name: "Prod 2", inventory: 20 });
  });

  afterAll(async () => {
    await closeConnections();
  });

  test("calculates true available inventory (total - reserved - payment_pending) for a single product", async () => {
    // For product1 (inventory = 10):
    // Add 2 reserved orders
    await seedOrder({
      product_id: product1.id,
      user_id: "user-1",
      status: "reserved",
      reservation_id: `${product1.id}:rev-sync-1`,
    });
    await seedOrder({
      product_id: product1.id,
      user_id: "user-2",
      status: "reserved",
      reservation_id: `${product1.id}:rev-sync-2`,
    });
    // Add 1 payment_pending order
    await seedOrder({
      product_id: product1.id,
      user_id: "user-3",
      status: "payment_pending",
      reservation_id: `${product1.id}:rev-sync-3`,
    });
    // Add 1 completed order (should NOT reduce available inventory since main inventory row is decremented on completion)
    await seedOrder({
      product_id: product1.id,
      user_id: "user-4",
      status: "completed",
      reservation_id: `${product1.id}:rev-sync-4`,
    });

    // Available inventory should be: 10 - 2 (reserved) - 1 (payment_pending) = 7
    await syncInventoryToRedis(product1.id);

    const redisInv = await getRedisValue(`inventory:product-${product1.id}`);
    expect(redisInv).toBe("7");
  });

  test("syncs all products when targetProductId is null", async () => {
    // Product 1: 1 reserved -> 10 - 1 = 9
    await seedOrder({
      product_id: product1.id,
      user_id: "u1",
      status: "reserved",
      reservation_id: `${product1.id}:rev-all-1`,
    });

    // Product 2: 3 payment_pending -> 20 - 3 = 17
    for (let i = 1; i <= 3; i++) {
      await seedOrder({
        product_id: product2.id,
        user_id: `u2-${i}`,
        status: "payment_pending",
        reservation_id: `${product2.id}:rev-all-${i}`,
      });
    }

    await syncInventoryToRedis(null);

    expect(await getRedisValue(`inventory:product-${product1.id}`)).toBe("9");
    expect(await getRedisValue(`inventory:product-${product2.id}`)).toBe("17");
  });

  test("publishes update message to Redis channel inventory-updates", async () => {
    const subscriber = redis.duplicate();
    const receivedMessages = [];

    subscriber.on("message", (channel, message) => {
      if (channel === "inventory-updates") {
        receivedMessages.push(JSON.parse(message));
      }
    });

    await subscriber.subscribe("inventory-updates");

    await syncInventoryToRedis(product1.id);

    // Wait briefly for subscriber callback
    await new Promise((r) => setTimeout(r, 150));

    expect(receivedMessages.length).toBeGreaterThanOrEqual(1);
    const msg = receivedMessages.find((m) => m && m.productId === product1.id);
    expect(msg).toBeDefined();
    expect(msg.newInventory).toBe(10);

    await subscriber.quit();
  });

  test("handles non-existent targetProductId gracefully", async () => {
    await expect(syncInventoryToRedis(99999)).resolves.not.toThrow();
  });
});
