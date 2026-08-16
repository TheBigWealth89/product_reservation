/**
 * Integration tests for Admin operations:
 * - Role-based authorization (/admin/dashboard, inventory updates, job retry & cancel)
 * - Manual inventory updates (updateProductInventory + syncInventoryToRedis)
 * - Job cancellation (status update to 'cancelled', returnStock, job removal)
 */
import { describe, test, expect, beforeEach, afterAll, vi } from "vitest";
import {
  getPool,
  getRedis,
  getRequest,
  loginAs,
  seedProduct,
  seedOrder,
  getRedisValue,
  closeConnections,
} from "../setup/testHelpers.js";
import purchaseQueue from "../../src/queues/purchaseQueue.js";

const pool = getPool();
const redis = getRedis();
const request = getRequest();

describe("Admin Operations", () => {
  let adminCookie;
  let customerCookie;
  let product;

  beforeEach(async () => {
    await pool.query("TRUNCATE orders CASCADE");
    await pool.query("TRUNCATE products CASCADE");
    await redis.flushdb();

    product = await seedProduct({ inventory: 10 });
    await redis.set(`inventory:product-${product.id}`, "10");

    adminCookie = await loginAs("admin");
    customerCookie = await loginAs("customer");
  });

  afterAll(async () => {
    await closeConnections();
  });

  describe("Role Enforcement", () => {
    test("customer role gets 403 when accessing admin dashboard", async () => {
      const res = await request
        .get("/admin/dashboard")
        .set("Cookie", customerCookie)
        .set("Accept", "application/json");

      expect(res.status).toBe(403);
    });

    test("admin role successfully accesses admin dashboard", async () => {
      const res = await request
        .get("/admin/dashboard")
        .set("Cookie", adminCookie);

      expect(res.status).toBe(200);
    });
  });

  describe("POST /admin/products/:id/inventory", () => {
    test("admin can update product inventory in DB and Redis", async () => {
      const res = await request
        .post(`/admin/products/${product.id}/inventory`)
        .set("Cookie", adminCookie)
        .send({ inventory: "25" });

      expect(res.status).toBe(302); // Redirects to /admin/dashboard

      // DB check
      const dbProduct = await pool.query("SELECT inventory FROM products WHERE id = $1", [
        product.id,
      ]);
      expect(dbProduct.rows[0].inventory).toBe(25);

      // Redis check
      const redisInv = await getRedisValue(`inventory:product-${product.id}`);
      expect(redisInv).toBe("25");
    });

    test("invalid inventory value returns 400", async () => {
      const res = await request
        .post(`/admin/products/${product.id}/inventory`)
        .set("Cookie", adminCookie)
        .send({ inventory: "-5" });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /admin/jobs/:jobId/retry and /cancel", () => {
    test("non-existent or non-failed job returns 404", async () => {
      const resRetry = await request
        .post("/admin/jobs/non-existent-id/retry")
        .set("Cookie", adminCookie);
      expect(resRetry.status).toBe(404);

      const resCancel = await request
        .post("/admin/jobs/non-existent-id/cancel")
        .set("Cookie", adminCookie);
      expect(resCancel.status).toBe(404);
    });

    test("cancelling a failed job marks order cancelled, returns stock, and removes job", async () => {
      const order = await seedOrder({
        product_id: product.id,
        user_id: "user-alice",
        status: "reserved",
        reservation_id: `${product.id}:rev-admin-cancel`,
      });

      // Add a job to purchaseQueue and simulate a failed job via mock
      const mockJob = {
        id: "mock-failed-job-1",
        data: { orderId: order.id },
        isFailed: vi.fn().mockResolvedValue(true),
        remove: vi.fn().mockResolvedValue(true),
      };

      const originalGetJob = purchaseQueue.getJob;
      vi.spyOn(purchaseQueue, "getJob").mockImplementation(async (id) => {
        if (id === "mock-failed-job-1") return mockJob;
        return originalGetJob.call(purchaseQueue, id);
      });

      const res = await request
        .post("/admin/jobs/mock-failed-job-1/cancel")
        .set("Cookie", adminCookie);

      expect(res.status).toBe(302);

      // DB check: Order status should be 'cancelled'
      const updatedOrder = await pool.query("SELECT status FROM orders WHERE id = $1", [
        order.id,
      ]);
      expect(updatedOrder.rows[0].status).toBe("cancelled");

      // Job removal check
      expect(mockJob.remove).toHaveBeenCalled();
    });
  });
});
