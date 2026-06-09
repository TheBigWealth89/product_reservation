# Running Tests

This document covers every npm test script, the Docker test environment, what a passing run looks like, and a priority ranking of test files by business risk.

For the testing philosophy and infrastructure see [strategy.md](strategy.md). For individual test case details see [test-cases.md](test-cases.md).

---

## npm Test Scripts

| Script | Command | What It Does |
|---|---|---|
| `npm test` | `cross-env NODE_ENV=test vitest run` | **(Recommended)** Full suite. Auto-starts Docker containers, runs all unit + integration + e2e tests, tears down Docker. |
| `npm run test:unit` | `cross-env NODE_ENV=test vitest run tests/unit` | Unit tests only. No Docker required — runs in milliseconds with no external connections. |
| `npm run test:integration` | `cross-env NODE_ENV=test vitest run tests/integration` | Integration suite only. Auto-starts and tears down Docker. |
| `npm run test:e2e` | `cross-env NODE_ENV=test vitest run tests/e2e` | E2E suite only. Auto-starts and tears down Docker. |
| `npm run test:coverage` | `cross-env NODE_ENV=test vitest run --coverage` | Full suite with V8 coverage report. Output written to `coverage/` directory. |
| `npm run test:watch` | `cross-env NODE_ENV=test vitest` | Watch mode. Re-runs affected tests on file save. Useful for TDD — requires Docker already running for integration/e2e tests. |

---

## Docker Test Environment

The test suite uses `docker-compose.test.yml` which is managed **automatically** by `tests/setup/globalSetup.js`. You do not need to start Docker manually when using the npm scripts above.

### What `globalSetup.js` does

```
npm test
  └── vitest run
        └── globalSetup.setup()
              ├── docker compose -f docker-compose.test.yml up -d --wait
              │     (blocks until postgres-test + redis-test healthchecks pass)
              ├── Connect to postgres-test
              ├── DROP TABLE IF EXISTS orders, products CASCADE
              ├── Run sql/init.sql  (fresh schema)
              ├── Seed: inventory:product-1 = 5 in redis-test
              └── Close setup connections
        └── [unit tests run]
        └── [integration tests run]
        └── [e2e tests run]
        └── globalSetup.teardown()
              └── docker compose -f docker-compose.test.yml down -v
```

### Clean Reproducible Run Command

For CI or when you want guaranteed isolation (no leftover containers from a previous interrupted run):

```bash
# Stop any leftover test containers, then run the full suite
docker compose -f docker-compose.test.yml down -v 2>/dev/null; npm test
```

### Running Tests With Docker Already Up

If you have manually started `docker-compose.test.yml` (e.g. for debugging), you can run individual test files without waiting for container startup each time:

```bash
# Start containers once
docker compose -f docker-compose.test.yml up -d --wait

# Run tests repeatedly without teardown
npx vitest run tests/integration/reservation.test.js

# Tear down when done
docker compose -f docker-compose.test.yml down -v
```

---

## `docker-compose.test.yml` — Full Breakdown

```yaml
services:
  postgres-test:
    image: postgres:15-alpine
    pull_policy: missing            # Never pull if image already exists locally
    tmpfs:
      - /var/lib/postgresql/data    # RAM storage — fast + auto-wiped on stop
    environment:
      POSTGRES_USER: test_user
      POSTGRES_PASSWORD: test_pass
      POSTGRES_DB: reservation_test
    ports:
      - "5434:5432"                 # Non-conflicting port (local dev uses 5433)
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U test_user -d reservation_test"]
      interval: 2s
      timeout: 5s
      retries: 10

  redis-test:
    image: redis:7-alpine
    pull_policy: missing
    tmpfs:
      - /data                       # RAM storage
    ports:
      - "6380:6379"                 # Non-conflicting port (local dev uses 6379)
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 5s
      retries: 10
```

| Option | Reason |
|---|---|
| `pull_policy: missing` | Do not hit Docker Hub on every test run — use the local image cache |
| `tmpfs` | RAM storage is faster than disk and is guaranteed clean on container stop |
| Ports `5434` / `6380` | Do not conflict with the local dev stack (5433 / 6379) — both can run simultaneously |
| `healthcheck interval: 2s, retries: 10` | Aggressive polling so containers are confirmed ready in under 20 seconds |
| No API server or worker services | Tests use `supertest` (no port binding) and call processor functions directly |

---

## Test Execution Order

Within a single `npm test` run, Vitest executes in this order:

```
1. globalSetup.setup()          — Docker up, schema created, Redis seeded
2. tests/unit/                  — (no Docker dependency, fastest)
   ├── redisKeys.test.js
   └── authenticate.test.js
3. tests/integration/           — (sequential, shared DB)
   ├── auth.test.js
   ├── health.test.js
   ├── rateLimiter.test.js
   ├── reservation.test.js
   ├── checkout.test.js
   └── webhook.test.js
4. tests/e2e/                   — (sequential, shared DB)
   ├── fulfillWorker.test.js
   └── expiresWorker.test.js
5. globalSetup.teardown()       — Docker down -v
```

Files within each directory run in the order Vitest discovers them (alphabetical by default). `fileParallelism: false` in `vitest.config.js` ensures all files run sequentially — never concurrently — to prevent `TRUNCATE` race conditions between files sharing the same database.

---

## What a Passing Test Run Looks Like

```
[globalSetup]  Starting Docker containers...
[+] Running 2/2
 ✔ Container product_reservation-postgres-test-1  Healthy
 ✔ Container product_reservation-redis-test-1     Healthy
[globalSetup]  Schema created and baseline product seeded
[globalSetup]  Redis connected (PONG received)
[globalSetup]  Redis inventory seeded for product-1

 RUN  tests/unit/redisKeys.test.js
 RUN  tests/unit/authenticate.test.js
 RUN  tests/integration/auth.test.js
 ...
 RUN  tests/e2e/expiresWorker.test.js

 ✓ tests/unit/redisKeys.test.js (6)
 ✓ tests/unit/authenticate.test.js (4)
 ✓ tests/integration/auth.test.js (5)
 ✓ tests/integration/health.test.js (4)
 ✓ tests/integration/rateLimiter.test.js (3)
 ✓ tests/integration/reservation.test.js (6)
 ✓ tests/integration/checkout.test.js (3)
 ✓ tests/integration/webhook.test.js (4)
 ✓ tests/e2e/fulfillWorker.test.js (3)
 ✓ tests/e2e/expiresWorker.test.js (4)

 Test Files  10 passed (10)
      Tests  42 passed (42)
   Start at  01:53:12
   Duration  18.42s (transform 120ms, setup 14.2s, collect 820ms, tests 3.4s)

[globalTeardown]  Tearing down Docker containers...
[globalTeardown]  Global teardown complete
```

**Exit codes**:
- `0` — all tests passed.
- `1` — one or more tests failed; check the failure output for the specific assertion.

---

## CI Integration

The full test suite runs in a single CI step. No separate Docker setup step is needed — `globalSetup.js` manages the container lifecycle:

```yaml
# GitHub Actions example
- name: Run test suite
  run: npm test
```

Prerequisites for CI:
- Docker must be available in the CI runner (GitHub-hosted runners include Docker).
- No environment variables from `.env.test` need to be set in CI — `globalSetup.js` uses hardcoded defaults matching `docker-compose.test.yml`.

---

## Priority Ranking — Business Risk

Files are ranked from highest to lowest business risk. If time is limited, implement and maintain the highest-ranked files first.

| Rank | File | Risk Category | Why |
|---|---|---|---|
| 1 | `tests/e2e/fulfillWorker.test.js` | **Data corruption** | The idempotency tests directly prevent double-inventory-decrement. A regression here costs money. |
| 2 | `tests/integration/reservation.test.js` | **Data corruption + overselling** | The concurrency test is the core proof that the Lua script prevents race conditions. Loss of this test removes the main architectural guarantee. |
| 3 | `tests/integration/webhook.test.js` | **Security + financial** | Tests Stripe signature verification and user identity validation. A regression could allow unauthenticated fulfillment or replay attacks. |
| 4 | `tests/e2e/expiresWorker.test.js` | **Inventory leakage** | Proves abandoned reservations are released. Without this, stock is permanently locked on cart abandonment. |
| 5 | `tests/integration/checkout.test.js` | **Financial accuracy** | Validates that expired reservations cannot proceed to payment. A regression could charge a user for stock they no longer hold. |
| 6 | `tests/integration/auth.test.js` | **Security** | RBAC enforcement. A regression allows non-admin users to access the admin dashboard and cancel/retry jobs. |
| 7 | `tests/integration/rateLimiter.test.js` | **Abuse prevention** | Rate limiting correctness. Lower priority than auth because a regression degrades protection rather than breaking a core flow. |
| 8 | `tests/unit/authenticate.test.js` | **Security (unit level)** | JWT logic correctness. Covered partially by auth integration tests, but unit tests catch edge cases faster. |
| 9 | `tests/unit/redisKeys.test.js` | **Key collision prevention** | Ensures Redis key generators produce correct strings. Low risk in practice but cheap to maintain. |
| 10 | `tests/integration/health.test.js` | **Operational** | Health endpoint shape. Lowest risk — a shape change breaks monitoring alerts but not core business logic. |

### Top 3 Files to Implement First (If Time Is Limited)

1. **`tests/e2e/fulfillWorker.test.js`** — The idempotency test is the single most valuable test in the suite. It directly prevents a double-charge scenario that would be invisible without it and requires a manual database audit to detect.

2. **`tests/integration/reservation.test.js`** — The concurrency `Promise.all` test is the only automated proof that the Lua script works correctly under load. Without it, the race condition protection is unverifiable by inspection alone.

3. **`tests/integration/webhook.test.js`** — The Stripe signature verification test and the metadata mismatch test protect the financial and security boundary of the application. Both are trivial to overlook in code review but catastrophic if broken in production.
