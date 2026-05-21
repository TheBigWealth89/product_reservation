/**
 * Integration tests for Critical Path I:
 * Health, readiness, and metrics endpoints.
 */
import { describe, test, expect, afterAll } from "vitest";
import {
  getRequest,
  loginAs,
  closeConnections,
} from "../setup/testHelpers.js";

const request = getRequest();

describe("Health & Readiness Endpoints (Path I)", () => {
  afterAll(async () => {
    await closeConnections();
  });

  test("GET /health returns 200 with status ok and uptime", async () => {
    const res = await request.get("/health").expect(200);

    expect(res.body.status).toBe("ok");
    expect(res.body.uptime).toBeDefined();
    expect(typeof res.body.uptime).toBe("number");
    expect(res.body.process).toBe("api-server");
    expect(res.body.timestamp).toBeDefined();
  });

  test("GET /ready returns 200 when all dependencies are healthy", async () => {
    const res = await request.get("/ready").expect(200);

    expect(res.body.status).toBe("ok");
    expect(res.body.checks).toBeDefined();
    expect(res.body.checks.postgres.status).toBe("ok");
    expect(res.body.checks.redis.status).toBe("ok");
    expect(res.body.checks.bullmq.status).toBe("ok");
  });

  test("GET /metrics without auth returns 401 or redirect", async () => {
    const res = await request
      .get("/metrics")
      .set("Accept", "application/json");

    expect([302, 401]).toContain(res.status);
  });

  test("GET /metrics with customer token returns 403", async () => {
    const customerCookie = await loginAs("customer");

    const res = await request
      .get("/metrics")
      .set("Cookie", customerCookie)
      .set("Accept", "application/json")
      .expect(403);

    expect(res.body.error).toBe("Forbidden");
  });

  test("GET /metrics with admin token returns 200 with system info", async () => {
    const adminCookie = await loginAs("admin");

    const res = await request
      .get("/metrics")
      .set("Cookie", adminCookie)
      .expect(200);

    expect(res.body.process).toBeDefined();
    expect(res.body.process.memory_mb).toBeDefined();
    expect(res.body.process.uptime_seconds).toBeDefined();
    expect(res.body.timestamp).toBeDefined();
  });
});
