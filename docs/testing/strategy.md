# Testing Strategy

This document covers the testing philosophy, tooling decisions, infrastructure setup, and test isolation approach for the Product Reservation System.

---

## Why Vitest

Vitest was chosen as the test runner for three specific reasons:

1. **Native ESM support** — The codebase uses `"type": "module"` in `package.json`. Jest requires Babel or `--experimental-vm-modules` to handle ESM imports; the configuration is fragile and breaks frequently across Jest versions. Vitest runs ESM natively with zero configuration.
2. **Jest-compatible API** — `describe`, `it`, `expect`, `vi.mock`, `vi.spyOn`, `beforeEach`, `afterEach` — every familiar Jest API works identically in Vitest. The migration cost for any developer who knows Jest is zero.
3. **Fast parallel execution with `forks` pool** — Vitest spawns each test file in a separate child process (`pool: 'forks'`), giving each file a clean global state. This is important for a test suite that manipulates shared database state.

### Why Not Jest

- Jest's ESM support requires `--experimental-vm-modules` (unstable) or a Babel transform (`babel-jest`). Babel must be configured to strip ES module syntax, which introduces its own version conflicts with packages that ship ESM-only (like `ioredis` v5, `nanoid`, `uuid` v14).
- Every ESM import would need to be compiled at test time, adding hundreds of milliseconds to startup and introducing transpilation bugs that do not exist in production.
- Vitest resolves all of this: the test code runs in the same module system as the production code.

---

## Test Packages

| Package | Version | Purpose |
|---|---|---|
| `vitest` | `^4.1.6` | Test runner, assertion library, spy/mock API |
| `supertest` | `^7.2.2` | HTTP testing — wraps the Express app without binding a port |
| `@vitest/coverage-v8` | `^4.1.6` | V8-native code coverage; no Istanbul instrumentation needed |

---

## `vitest.config.js` Explained

```js
export default defineConfig({
  test: {
    environment:     "node",       // No jsdom — pure server-side tests
    globals:         false,        // Explicit imports required (no global describe/it)
    pool:            "forks",      // Each test file runs in a separate child process
    testTimeout:     15000,        // 15s per test — covers slow DB round-trips
    hookTimeout:     15000,        // 15s for beforeEach/afterEach hooks
    include:         ["tests/**/*.test.js"],
    globalSetup:     ["./tests/setup/globalSetup.js"],
    fileParallelism: false,        // Test files run sequentially (shared DB state)
    coverage: {
      provider: "v8",
      include:  ["src/**/*.js"],
      exclude:  ["src/views/**", "src/public/**", "src/assets/**", "src/config/loadEnv.js"],
    },
    sequence: {
      setupFiles: "list",          // setupFiles run in defined order, not parallel
    },
  },
});
```

| Setting | Value | Why |
|---|---|---|
| `pool: "forks"` | Child processes | Isolates global state between files; prevents module-level singleton leakage |
| `testTimeout: 15000` | 15 s | Real PostgreSQL + Redis round-trips can take 200–400 ms; concurrency tests with 6 parallel requests take longer |
| `fileParallelism: false` | Sequential | Integration tests share a single database; parallel file execution causes `TRUNCATE` race conditions |
| `environment: "node"` | Node.js | No browser globals needed; keeps the test environment identical to the production runtime |
| `coverage.provider: "v8"` | V8 built-in | Coverage is collected by the V8 engine directly — no source instrumentation, no transform overhead |

---

## Three Test Layers

| Layer | Location | Uses real DB/Redis? | Stripe mocked? | What it tests |
|---|---|---|---|---|
| Unit | `tests/unit/` | No | N/A | Pure functions with no I/O |
| Integration | `tests/integration/` | Yes | Yes (vi.mock) | HTTP routes via supertest against real Postgres + Redis |
| E2E | `tests/e2e/` | Yes | Yes (vi.mock) | Processor functions called directly; asserts DB + Redis state transitions |

### Unit Tests

Unit tests have zero external dependencies. They import a function, call it with controlled inputs, and assert the output. No database connections, no Redis, no network. They run in milliseconds and can execute without Docker.

Currently covers:
- `src/utils/redisKeys.js` — key generator functions produce correct string formats.
- `src/middleware/authenticate.js` — JWT signing and role extraction from raw tokens.

### Integration Tests

Integration tests hit real Express routes via `supertest`. They use the actual PostgreSQL and Redis instances started by `docker-compose.test.yml`. Stripe is mocked at the module level (`vi.mock("stripe")`) to prevent real network calls and charges during testing.

The integration layer is the primary layer for testing HTTP behaviour: status codes, response shapes, authentication enforcement, rate limiting, and webhook handling.

### E2E Tests (Processor Level)

E2E tests call the extracted processor functions directly — `fulfillOrderProcessor(job)`, `expiryProcessor()`, `cleanupProcessor()` — with real database connections. This approach tests the full business logic path (SQL transactions, Redis operations, state transitions) without the overhead of spinning up BullMQ workers or waiting for cron intervals to fire.

These are called "E2E" because they exercise the complete data path from function input through to database and Redis state, without any mocking of the data layer.

---

## Why Lua Scripts Are Not Unit Tested

The `decrement_inventory.lua` and `validate_cart.lua` scripts are tested only at the integration level, not with dedicated unit tests. The reason: Lua scripts executed via Redis's `EVAL` command run inside the Redis runtime, not in the Node.js process. There is no pure-function equivalent to unit test — the script's correctness depends on Redis's atomic execution model. Testing it with a mock Redis would test the mock, not the script.

Integration tests that call `POST /product/:id/reserve` and `POST /product/create-payment-intent` against a real Redis instance provide sufficient coverage.

---

## `docker-compose.test.yml` — Why Dedicated

The test environment uses its own Compose file (`docker-compose.test.yml`) rather than sharing `docker-compose.local.yml` for these reasons:

1. **No data pollution** — test runs `DROP TABLE IF EXISTS orders CASCADE` before creating the schema. Running this against the local dev database would wipe development data.
2. **Different ports** — PostgreSQL on `5434`, Redis on `6380`. These do not conflict with the local dev stack (PostgreSQL on `5433`, Redis on `6379`), so developers can run tests while the local stack is still running.
3. **tmpfs storage** — test databases use `tmpfs` (RAM) for storage. Guaranteed clean state on container stop; no leftover data between test runs. See [../development/docker.md](../development/docker.md) for the full tmpfs rationale.
4. **No application services** — the test Compose file starts only `postgres-test` and `redis-test`. The API server and workers are not started; `supertest` wraps the Express app directly and processor functions are called directly in tests.

---

## Global Setup and Teardown

**File**: `tests/setup/globalSetup.js`

Runs once before any test file executes. Exports two functions that Vitest calls in sequence:

### `setup()`

1. Detects if this is a unit-only run (`tests/unit` in argv). If so, skips all DB/Redis setup.
2. Runs `docker compose -f docker-compose.test.yml up -d --wait` — starts containers and blocks until healthchecks pass.
3. Connects to `postgres-test`, drops existing tables, and runs `sql/init.sql` to create a clean schema.
4. Connects to `redis-test`, runs `PING` to verify connectivity, seeds `inventory:product-1 = 5`.
5. Closes both connections (test files create their own connections via `testHelpers.js`).

### `teardown()`

1. Skips if unit-only run.
2. Runs `docker compose -f docker-compose.test.yml down -v` — removes containers and named volumes.

---

## Per-Test Isolation Pattern

Integration tests share a single database. To prevent test order from affecting results:

- **`beforeEach`** in each integration test file truncates relevant tables or deletes specific rows.
- **Redis state** is cleared with `await redis.flushdb()` in `beforeEach` hooks of tests that depend on a clean Redis state (e.g. rate limiter tests that would inherit a hit count from the previous test).
- **`FLUSHALL` is never used** — it would wipe all Redis state including keys that other concurrent test files or the global setup depend on. Targeted `DEL` or `FLUSHDB` (scoped to the test Redis database) is used instead.

---

## `testHelpers.js` Exports

**File**: `tests/setup/testHelpers.js`

Provides lazy-initialised shared connections and reusable utilities. Connections are created once per Vitest worker process (not once per test file).

| Export | Signature | Purpose |
|---|---|---|
| `getPool()` | `() → pg.Pool` | Returns a shared PostgreSQL pool; creates it on first call. `max: 2` in test env to prevent connection exhaustion |
| `getRedis()` | `() → ioredis.Redis` | Returns a shared Redis client; creates it on first call |
| `getRequest()` | `() → SuperTest` | Returns a supertest instance wrapping the Express app |
| `closeConnections()` | `async () → void` | Closes pool and Redis client; resets internal references to `null` |
| `loginAs(role)` | `async (role: 'customer' \| 'admin') → string` | POSTs to `/login`, extracts and returns the `token=...` cookie string |
| `seedProduct(overrides?)` | `async (overrides?: object) → object` | Inserts a product row with defaults; returns the inserted row |
| `seedOrder(overrides?)` | `async (overrides?: object) → object` | Inserts an order row with defaults; returns the inserted row |
| `getRedisValue(key)` | `async (key: string) → string \| null` | Calls `redis.get(key)` |
| `getRedisSet(key)` | `async (key: string) → string[]` | Calls `redis.smembers(key)` |
| `getRedisTTL(key)` | `async (key: string) → number` | Calls `redis.ttl(key)` |
| `clearRedisKeys(...keys)` | `async (...keys: string[]) → void` | Calls `redis.del(...keys)`; never uses `FLUSHALL` |
