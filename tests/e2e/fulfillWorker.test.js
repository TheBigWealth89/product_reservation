/**
 * E2E tests for Critical Path E:
 * fulfillOrderWorker processor — idempotency, successful fulfillment, error handling.
 */
import { describe, test, expect, beforeEach, afterAll } from "vitest";
import {
  getPool,
  seedProduct,
  seedOrder,
  closeConnections,
} from "../setup/testHelpers.js";
import { fulfillOrderProcessor } from "../../src/workers/processors/fulfillOrder.processor.js";

const pool = getPool();

describe("fulfillOrderWorker Processor (Path E)", () => {
  let product;

  beforeEach(async () => {
    await pool.query("TRUNCATE orders CASCADE");
    await pool.query("TRUNCATE products CASCADE");
    product = await seedProduct({ inventory: 5 });
  });

  afterAll(async () => {
    await closeConnections();
  });

  test("successful fulfillment: order becomes completed, DB inventory decremented", async () => {
    const order = await seedOrder({
      product_id: product.id,
      status: "payment_pending",
      reservation_id: `${product.id}:rev-fulfill-1`,
    });

    await fulfillOrderProcessor({ id: "test-job-1", data: { orderId: order.id } });

    // DB: order status = 'completed'
    const orderResult = await pool.query("SELECT status FROM orders WHERE id = $1", [order.id]);
    expect(orderResult.rows[0].status).toBe("completed");

    // DB: product inventory decremented by 1
    const prodResult = await pool.query("SELECT inventory FROM products WHERE id = $1", [product.id]);
    expect(prodResult.rows[0].inventory).toBe(4);
  });

  test("duplicate job idempotency: already-completed order is not re-decremented", async () => {
    const order = await seedOrder({
      product_id: product.id,
      status: "completed",
      reservation_id: `${product.id}:rev-fulfill-2`,
    });

    // Set inventory to 4 (as if already decremented once)
    await pool.query("UPDATE products SET inventory = 4 WHERE id = $1", [product.id]);

    // Call processor again with the same order
    await fulfillOrderProcessor({ id: "test-job-dup", data: { orderId: order.id } });

    // DB: order still 'completed'
    const orderResult = await pool.query("SELECT status FROM orders WHERE id = $1", [order.id]);
    expect(orderResult.rows[0].status).toBe("completed");

    // DB: inventory NOT decremented again (still 4)
    const prodResult = await pool.query("SELECT inventory FROM products WHERE id = $1", [product.id]);
    expect(prodResult.rows[0].inventory).toBe(4);
  });

  test("missing orderId throws error", async () => {
    await expect(
      fulfillOrderProcessor({ id: "test-job-bad", data: {} })
    ).rejects.toThrow("missing orderId");
  });
});
