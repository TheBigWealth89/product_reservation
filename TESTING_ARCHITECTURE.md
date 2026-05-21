# Product Reservation System - Testing Documentation

This document provides a comprehensive overview of the testing architecture, strategies, and individual test suites implemented for the Product Reservation System. The primary goal of this testing suite is to guarantee data integrity, prevent race conditions, and ensure the reliability of business-critical paths using **Vitest** and **Docker Compose**.

---

## 1. Testing Strategy & Infrastructure

The project uses a highly isolated, containerized testing strategy to avoid data pollution between local development and test runs.

### Key Tools
*   **Vitest**: Chosen for its native ECMAScript Modules (ESM) support, fast parallel execution, and Jest-compatible API.
*   **Supertest**: Allows integration tests to hit Express API routes without opening actual HTTP server ports, preventing `EADDRINUSE` errors and speeding up execution.
*   **Docker Compose (`docker-compose.test.yml`)**: Provisions dedicated `postgres-test` and `redis-test` containers.
*   **`tmpfs` (In-Memory Storage)**: The test databases use Docker's `tmpfs` mounts. This ensures extremely fast I/O operations and guarantees that when the container stops, the data is completely destroyed, leaving no state behind.

### Global Setup & Teardown
*   **`tests/setup/globalSetup.js`**: Runs once before the entire test suite. It connects to the database, drops/recreates the schema using `sql/init.sql`, seeds a baseline product, and verifies Redis connectivity.
*   **`tests/setup/testHelpers.js`**: Manages lazy connection pooling per Vitest worker. Provides reusable utilities for tests like `loginAs()`, `seedProduct()`, `seedOrder()`, and Redis query wrappers.

### Executing Tests
We've added specific scripts to `package.json` for running tests. The Docker container lifecycle is handled automatically via Vitest's `globalSetup` and `globalTeardown`, spinning up and tearing down isolated databases strictly when needed.

*   **`npm test`**: **(Recommended)** Runs the entire test suite. Automatically starts Postgres/Redis via Docker Compose, runs all tests, and gracefully destroys the containers afterward.
*   **`npm run test:unit`**: Runs only the fast unit tests. Automatically bypasses Docker setup.
*   **`npm run test:integration`**: Runs the integration suite. Automatically handles Docker setup and teardown.
*   **`npm run test:e2e`**: Runs the end-to-end worker tests. Automatically handles Docker setup and teardown.

---

## 2. Refactoring for Testability

To achieve deterministic testing, we had to decouple our infrastructure (servers, cron jobs, queues) from our core business logic:
*   **`src/app.js`**: Extracted the core Express configuration and routing from `server.js`. This allows `supertest` to load the application logic without triggering `app.listen()` and the database connection loops.
*   **`src/workers/processors/`**: Extracted the actual data-processing code from `fulfillOrderWorker`, `expiresWorker`, and `cleanupWorker`. Instead of fighting BullMQ or `node-cron` timing in tests, our E2E tests invoke these processor functions directly with mocked payload data to assert database and Redis state transitions.

---

## 3. Test Suite Breakdown (Critical Paths)

The tests are organized into `unit`, `integration`, and `e2e` layers based on their scope and business path (Paths A-I).

### Path A & B: Reservation & Concurrency
**File:** `tests/integration/reservation.test.js`
*   **Purpose:** The most critical test in the system. Ensures users can reserve products and that inventory is decremented safely.
*   **Concurrency Test:** Proves the atomicity of our `decrement_inventory.lua` Redis script. It fires 6 simultaneous requests using `Promise.all` against a product with an inventory of 3. It rigorously asserts that exactly 3 requests succeed, exactly 3 fail, no overselling occurs, and the Redis inventory never drops below zero.

### Path C: Checkout and Payment Intent
**File:** `tests/integration/checkout.test.js`
*   **Purpose:** Validates the cart and creates a Stripe Payment Intent.
*   **Coverage:** Ensures that if a user's reservation key expires in Redis, they cannot proceed to checkout. It uses `vi.mock("stripe")` to prevent actual network calls to Stripe, testing the DB state transition to `payment_pending`.

### Path D: Webhook Fulfillment
**File:** `tests/integration/webhook.test.js`
*   **Purpose:** Secures the financial boundary of the application by testing the Stripe webhook endpoint.
*   **Coverage:** Verifies that a valid webhook triggers `purchaseQueue.add`. Crucially, it tests security boundaries: what happens with invalid signatures (rejected) and what happens if a malicious user tries to pass a Stripe payload where the `metadata.user_id` doesn't match the database owner.

### Path E: Fulfill Order Worker (Idempotency)
**File:** `tests/e2e/fulfillWorker.test.js`
*   **Purpose:** Tests the extracted `fulfillOrderProcessor`.
*   **Coverage:** Proves that fulfilling an order correctly transitions it to `completed` and permanently decrements PostgreSQL inventory. It heavily tests **idempotency**: if Stripe fires the exact same webhook twice, the worker must recognize the order is already `completed` and refuse to decrement the inventory a second time.

### Path F: Expiry Worker
**File:** `tests/e2e/expiresWorker.test.js`
*   **Purpose:** Tests the extracted `expiryProcessor` which runs on a cron interval in production.
*   **Coverage:** Asserts that `reserved` orders that exceed their 10-minute timeout are marked as `expired`, and that stock is successfully returned to Redis. It also proves that orders in `payment_pending` status are safely ignored by the expiry sweep.

### Path G: Authentication and RBAC
**File:** `tests/integration/auth.test.js`
*   **Purpose:** Tests the JWT authentication flow and Role-Based Access Control (RBAC).
*   **Coverage:** Validates that standard users are issued `HttpOnly` cookies, that unauthorized requests redirect to `/login` or return 401/403, and that standard users cannot escalate privileges to access the `/admin` endpoints.

### Path H: Rate Limiting
**File:** `tests/integration/rateLimiter.test.js`
*   **Purpose:** Prevents brute-force/denial-of-service attacks on critical endpoints like reservation.
*   **Coverage:** Simulates 10 rapid, successive requests to the reservation endpoint (which all succeed), and proves that the 11th request correctly returns a `429 Too Many Requests` status along with a `retryAfter` payload.

### Path I: Health Endpoints
**File:** `tests/integration/health.test.js`
*   **Purpose:** Ensures DevOps readiness and liveness probes function correctly.
*   **Coverage:** Validates the shape of `/health` and `/ready` responses, ensuring they accurately report the status of Postgres, Redis, and BullMQ dependencies. It also verifies that `/metrics` is strictly restricted to `admin` users.

### Unit Tests
**Files:** `tests/unit/redisKeys.test.js`, `tests/unit/authenticate.test.js`
*   **Purpose:** Fast, isolated testing of pure functions without needing database connections.
*   **Coverage:** Ensures our Redis key generators produce the correct string formats (preventing collision bugs) and that the JWT signing/verification logic properly extracts user scopes from raw tokens.

---

## 4. Common Pitfalls & Resolutions

During the evolution of this test suite, several architectural lessons were learned regarding testing distributed systems:

1.  **Docker Container Timing & Lifecycle Management:**
    *   **Issue:** Tests would crash on startup because Vitest's `globalSetup` executed before the Postgres container was fully ready to accept connections. We also had orphaned containers if developers forgot to tear them down.
    *   **Resolution:** Moved Docker orchestration directly into Vitest's `globalSetup.js` and `globalTeardown.js` using `child_process.execSync`. Added the `--wait` flag so test execution halts until Docker's internal `healthcheck` scripts report a `Healthy` status. Containers are automatically destroyed post-test via `down -v`.

2.  **Vitest Parallelism & Shared Database State:**
    *   **Issue:** Integration tests failed randomly (Flaky Tests) because multiple test files were executing `TRUNCATE orders CASCADE` concurrently, deleting records while other tests were running assertions.
    *   **Resolution:** Set `fileParallelism: false` in `vitest.config.js`. Because tests rely on a shared database state, enforcing sequential execution ensures perfect test isolation and prevents race conditions.

3.  **Connection Pool Exhaustion:**
    *   **Issue:** With Vitest running parallel forks, the `pg.Pool` easily exceeded PostgreSQL's default limit of 100 max connections, leading to `ECONNRESET` exceptions mid-test.
    *   **Resolution:** Lowered the `max` pool connection count to `2` specifically when `NODE_ENV === "test"`, preventing connection exhaustion.

4.  **IPv6 `localhost` Resolution:**
    *   **Issue:** Node.js resolves `localhost` to the IPv6 address `::1` before IPv4. If Docker only maps ports to IPv4, tests will fail to connect or mistakenly connect to non-Docker local instances.
    *   **Resolution:** Exclusively use `127.0.0.1` for `DB_HOST` and `REDIS_URL` in `.env.test`.

5.  **Redis Test State Leakage (Rate Limits):**
    *   **Issue:** Sequential tests would inherit Redis state from previous tests (e.g., rate limits), causing false positive `429 Too Many Requests` failures on endpoints downstream.
    *   **Resolution:** Added `await redis.flushdb()` to the `beforeEach` hooks in critical integration suites to guarantee a pristine Redis environment for every test scenario.
