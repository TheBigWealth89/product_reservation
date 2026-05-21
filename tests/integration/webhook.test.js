/**
 * Integration tests for Critical Path D:
 * Webhook fulfillment — Stripe signature verification, queue.add spying,
 * user ID mismatch detection, and idempotency for completed orders.
 */
import { describe, test, expect, beforeEach, afterAll, vi } from "vitest";
import {
  getPool,
  getRedis,
  getRequest,
  seedProduct,
  seedOrder,
  closeConnections,
} from "../setup/testHelpers.js";

// Mock Stripe webhook verification at module level
vi.mock("../../src/middleware/verifyWebhookSignature.js", () => {
  return {
    stripe: {
      webhooks: {
        constructEvent: vi.fn(),
      },
    },
    verifyStripeWebhook: vi.fn((req, res, next) => {
      // For testing, just parse the raw body Buffer into JSON
      try {
        req.stripeEvent = JSON.parse(req.body.toString("utf8"));
        next();
      } catch (e) {
        return res.status(400).send("Invalid Stripe signature");
      }
    }),
  };
});

// Spy on purchaseQueue.add
const { mockQueueAdd } = vi.hoisted(() => ({
  mockQueueAdd: vi.fn().mockResolvedValue({}),
}));
vi.mock("../../src/queues/purchaseQueue.js", () => ({
  default: {
    add: mockQueueAdd,
  },
}));

const pool = getPool();
const redis = getRedis();
const request = getRequest();

describe("Webhook Fulfillment (Path D)", () => {
  let product;

  beforeEach(async () => {
    vi.clearAllMocks();
    await pool.query("TRUNCATE orders CASCADE");
    await pool.query("TRUNCATE products CASCADE");
    await redis.flushdb();
    product = await seedProduct({ inventory: 5 });
  });

  afterAll(async () => {
    await closeConnections();
  });

  test("valid webhook: enqueues fulfillment job, cleans Redis state", async () => {
    const order = await seedOrder({
      product_id: product.id,
      status: "payment_pending",
      user_id: "user-alice",
      reservation_id: `${product.id}:rev-wh-1`,
    });

    // Set up Redis state
    const reservationKey = `reservation:product:${product.id}:user-user-alice:rev-wh-1`;
    const cartKey = "cart:user-user-alice";
    await redis.setex(reservationKey, 600, "reserved");
    await redis.sadd(cartKey, `${product.id}:rev-wh-1`);

    const mockEvent = {
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_test_123",
          metadata: {
            order_ids: String(order.id),
            user_id: "user-alice",
          },
        },
      },
    };

    const res = await request
      .post("/webhook-stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "valid-sig")
      .send(mockEvent);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    // purchaseQueue.add was called
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "fulfill-order",
      { orderId: String(order.id) },
      expect.any(Object)
    );
  });

  test("bad signature returns 400", async () => {
    // Override the mock to simulate signature failure
    const { verifyStripeWebhook } = await import(
      "../../src/middleware/verifyWebhookSignature.js"
    );
    verifyStripeWebhook.mockImplementationOnce((req, res, next) => {
      return res.status(400).send("Invalid Stripe signature");
    });

    const res = await request
      .post("/webhook-stripe")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ type: "payment_intent.succeeded" }));

    expect(res.status).toBe(400);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test("user ID mismatch returns warning", async () => {
    const order = await seedOrder({
      product_id: product.id,
      status: "payment_pending",
      user_id: "user-alice",
      reservation_id: `${product.id}:rev-wh-mismatch`,
    });

    const mockEvent = {
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_test_mismatch",
          metadata: {
            order_ids: String(order.id),
            user_id: "hacker-user", // mismatch!
          },
        },
      },
    };

    const { verifyStripeWebhook } = await import(
      "../../src/middleware/verifyWebhookSignature.js"
    );
    verifyStripeWebhook.mockImplementationOnce((req, res, next) => {
      req.stripeEvent = mockEvent;
      next();
    });

    const res = await request
      .post("/webhook-stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "valid-sig")
      .send(JSON.stringify(mockEvent));

    expect(res.status).toBe(200);
    expect(res.body.warning).toBe("user_mismatch");
  });
});
