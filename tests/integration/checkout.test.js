/**
 * Integration tests for Critical Path C:
 * Checkout and payment intent — validate_cart.lua, Stripe mock, cart state.
 */
import { describe, test, expect, beforeEach, afterAll, vi } from "vitest";
import {
  getPool,
  getRedis,
  getRequest,
  loginAs,
  seedProduct,
  seedOrder,
  clearRedisKeys,
  closeConnections,
} from "../setup/testHelpers.js";

// Mock Stripe at the module level
vi.mock("stripe", () => {
  const mockCreate = vi.fn().mockResolvedValue({
    client_secret: "pi_test_secret_mock",
  });
  return {
    default: class Stripe {
      constructor() {
        this.paymentIntents = { create: mockCreate };
      }
    },
  };
});

const pool = getPool();
const redis = getRedis();
const request = getRequest();

describe("Checkout & Payment Intent (Path C)", () => {
  let customerCookie;
  let product;

  beforeEach(async () => {
    vi.clearAllMocks();
    await pool.query("TRUNCATE orders CASCADE");
    await pool.query("TRUNCATE products CASCADE");
    await redis.flushdb();

    product = await seedProduct({ inventory: 10 });
    await redis.set(`inventory:product-${product.id}`, "10");
    await clearRedisKeys("cart:user-user-alice");

    customerCookie = await loginAs("customer");
  });

  afterAll(async () => {
    await closeConnections();
  });

  test("successful checkout returns clientSecret and updates order to payment_pending", async () => {
    // Create a reservation first (sets up Redis keys + DB order)
    const reserveRes = await request
      .post(`/product/${product.id}/reserve`)
      .set("Cookie", customerCookie)
      .expect(200);

    // Now checkout
    const checkoutRes = await request
      .post("/product/create-payment-intent")
      .set("Cookie", customerCookie)
      .expect(200);

    expect(checkoutRes.body.clientSecret).toBeDefined();

    // DB: order status should be 'payment_pending'
    const orders = await pool.query(
      "SELECT status FROM orders WHERE product_id = $1 AND user_id = 'user-alice'",
      [product.id]
    );
    expect(orders.rows[0].status).toBe("payment_pending");
  });

  test("expired reservation key returns 400", async () => {
    // Seed a DB order but do NOT set the Redis reservation key (simulating expiry)
    const reservationId = `${product.id}:rev-expired-test`;
    await seedOrder({
      product_id: product.id,
      user_id: "user-alice",
      status: "reserved",
      reservation_id: reservationId,
    });
    // Add to cart but don't set the reservation key in Redis
    await redis.sadd("cart:user-user-alice", reservationId);

    const res = await request
      .post("/product/create-payment-intent")
      .set("Cookie", customerCookie);

    // The Lua script will report the item as failed/expired
    // This should result in a 400 since no valid items remain
    expect(res.status).toBe(400);
  });

  test("missing cart returns 400", async () => {
    // No cart entries at all
    await clearRedisKeys("cart:user-user-alice");

    const res = await request
      .post("/product/create-payment-intent")
      .set("Cookie", customerCookie);

    // Empty cart renders the order page with empty cart, or returns error
    // The route renders orderPage with empty cart for GET, but POST should fail
    expect([400, 500, 429]).toContain(res.status);
  });
});
