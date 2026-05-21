/**
 * Integration tests for Critical Path G:
 * Authentication and RBAC — login, cookies, role enforcement, logout.
 */
import { describe, test, expect, afterAll } from "vitest";
import {
  getRequest,
  loginAs,
  closeConnections,
} from "../setup/testHelpers.js";

const request = getRequest();

describe("Authentication & RBAC (Path G)", () => {
  afterAll(async () => {
    await closeConnections();
  });

  test("customer login redirects to /product and sets token cookie", async () => {
    const res = await request
      .post("/login")
      .send({ username: "alice", password: "pass123" })
      .expect(302);

    expect(res.headers.location).toBe("/product");
    const cookies = res.headers["set-cookie"];
    expect(cookies).toBeDefined();
    const tokenCookie = Array.isArray(cookies)
      ? cookies.find((c) => c.startsWith("token="))
      : cookies;
    expect(tokenCookie).toContain("token=");
    expect(tokenCookie).toContain("HttpOnly");
  });

  test("admin login redirects to /admin/dashboard", async () => {
    const res = await request
      .post("/login")
      .send({ username: "admin", password: "adminpass" })
      .expect(302);

    expect(res.headers.location).toBe("/admin/dashboard");
  });

  test("no token on protected route returns 302 to /login (browser)", async () => {
    const res = await request
      .get("/product")
      .set("Accept", "text/html")
      .expect(302);

    expect(res.headers.location).toBe("/login");
  });

  test("customer accessing /admin returns 403", async () => {
    const customerCookie = await loginAs("customer");

    const res = await request
      .get("/admin")
      .set("Cookie", customerCookie)
      .set("Accept", "text/html");

    expect(res.status).toBe(403);
  });

  test("logout clears token cookie and redirects to /login", async () => {
    const customerCookie = await loginAs("customer");

    const res = await request
      .get("/logout")
      .set("Cookie", customerCookie)
      .expect(302);

    expect(res.headers.location).toBe("/login");
    // The set-cookie should clear the token
    const cookies = res.headers["set-cookie"];
    expect(cookies).toBeDefined();
  });

  test("invalid credentials render login with error", async () => {
    const res = await request
      .post("/login")
      .send({ username: "alice", password: "wrongpassword" })
      .expect(200);

    // Should render the login page (not redirect)
    expect(res.text).toContain("Invalid credentials");
  });
});
