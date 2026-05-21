import { describe, test, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

// Mock the loadEnv module to prevent file-system side effects
vi.mock("../../src/config/loadEnv.js", () => ({}));

// Set a test JWT secret before importing authenticate
process.env.JWT_SECRET = "test-jwt-secret-not-for-production";

const { authenticate, requireRole } = await import(
  "../../src/middleware/authenticate.js"
);

describe("authenticate middleware", () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      cookies: {},
      headers: {},
      accepts: vi.fn().mockReturnValue(false), // simulate API client (not browser)
    };
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      redirect: vi.fn().mockReturnThis(),
      clearCookie: vi.fn(),
    };
    next = vi.fn();
  });

  test("passes valid cookie token and sets req.user", () => {
    const token = jwt.sign(
      { sub: "user-alice", role: "customer" },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );
    req.cookies.token = token;

    authenticate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({ id: "user-alice", role: "customer" });
  });

  test("passes valid Bearer header token", () => {
    const token = jwt.sign(
      { sub: "admin-1", role: "admin" },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );
    req.headers.authorization = `Bearer ${token}`;

    authenticate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({ id: "admin-1", role: "admin" });
  });

  test("returns 401 when no token provided (API client)", () => {
    authenticate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized" });
  });

  test("redirects to /login when no token provided (browser)", () => {
    req.accepts = vi.fn().mockReturnValue(true);

    authenticate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith("/login");
  });

  test("returns 401 for expired token (API client)", () => {
    const token = jwt.sign(
      { sub: "user-alice", role: "customer" },
      process.env.JWT_SECRET,
      { expiresIn: "-1s" } // already expired
    );
    req.cookies.token = token;

    authenticate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.clearCookie).toHaveBeenCalledWith("token");
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe("requireRole middleware", () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      user: { id: "user-alice", role: "customer" },
      accepts: vi.fn().mockReturnValue(false),
    };
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
    next = vi.fn();
  });

  test("calls next() when role matches", () => {
    const middleware = requireRole("customer");
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test("returns 403 when role does not match (API client)", () => {
    const middleware = requireRole("admin");
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "Forbidden" });
  });

  test("returns 403 text when role does not match (browser)", () => {
    req.accepts = vi.fn().mockReturnValue(true);
    const middleware = requireRole("admin");
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
