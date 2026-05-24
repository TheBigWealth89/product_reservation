# Test Cases

Complete reference for every critical path in the test suite. Each path maps to a test file, lists every case in structured format, and notes the minimum case count required.

Format for each case: **CASE** (what scenario) / **SETUP** (preconditions) / **ACTION** (what the test does) / **ASSERT** (what it verifies) / **TYPE** (unit / integration / e2e).

For test infrastructure and isolation patterns see [strategy.md](strategy.md). For how to run these tests see [running-tests.md](running-tests.md).

---

## Path A — Reservation (Happy Path & Inventory)

**File**: `tests/integration/reservation.test.js`
**Minimum cases**: 4

**What it tests**: The core reservation flow — that a user can reserve a product and that the inventory counters in both Redis and PostgreSQL are updated correctly.

**Why it matters**: Reservation is the entry point of every order. A bug here means either overselling (inventory goes below zero) or incorrect rejection of valid requests.

---

| Case | Setup | Action | Assert | Type |
|---|---|---|---|---|
| A-1: Successful reservation decrements Redis | Product in DB (inventory=5); Redis key set to 5; user authenticated | `POST /product/:id/reserve` | HTTP 200; Redis `inventory:product-{id}` = 4; reservation TTL key exists with TTL ~600s; order row in DB with `status='reserved'` | Integration |
| A-2: Out-of-stock returns 409 | Product in DB (inventory=1); Redis key set to 0 | `POST /product/:id/reserve` | HTTP 409; Redis key still 0; no new order row inserted | Integration |
| A-3: Unauthenticated request returns 401 | No auth cookie | `POST /product/:id/reserve` | HTTP 401; no DB or Redis change | Integration |
| A-4: Cart entry added to Redis set | Product seeded; user authenticated | `POST /product/:id/reserve` | `SMEMBERS cart:user-{userId}` contains the new cart entry string | Integration |

---

## Path B — Concurrency (Race Condition Prevention)

**File**: `tests/integration/reservation.test.js` (within the same file as Path A)
**Minimum cases**: 2

**What it tests**: That the `decrement_inventory.lua` Lua script prevents overselling when multiple users reserve simultaneously.

**Why it matters**: This is the entire reason the system uses Lua scripts. Failing this test means the core architectural guarantee is broken.

---

| Case | Setup | Action | Assert | Type |
|---|---|---|---|---|
| B-1: Exactly 3 of 6 concurrent requests succeed | Product seeded with inventory=3; Redis key=3; 6 different authenticated users ready | `Promise.all(6× POST /product/:id/reserve)` simultaneously | Exactly 3 responses are HTTP 200; exactly 3 responses are HTTP 409; Redis inventory = 0 (never negative); exactly 3 order rows with `status='reserved'` in DB | Integration |
| B-2: Redis inventory never goes below zero | Product seeded with inventory=1; Redis key=1; 10 concurrent users | `Promise.all(10× POST /product/:id/reserve)` | Redis `inventory:product-{id}` ≥ 0 at all times; final value = 0; exactly 1 success | Integration |

### Concurrency Test Design

```js
// B-1 implementation pattern
const results = await Promise.all(
  users.map(user =>
    getRequest()
      .post(`/product/${product.id}/reserve`)
      .set("Cookie", user.cookie)
  )
);

const successes = results.filter(r => r.status === 200);
const failures  = results.filter(r => r.status === 409);

expect(successes).toHaveLength(3);
expect(failures).toHaveLength(3);

const inventory = await getRedisValue(`inventory:product-${product.id}`);
expect(parseInt(inventory)).toBe(0);
expect(parseInt(inventory)).toBeGreaterThanOrEqual(0);
```

---

## Path C — Checkout and Payment Intent

**File**: `tests/integration/checkout.test.js`
**Minimum cases**: 3

**What it tests**: Cart validation via `validate_cart.lua` and Stripe PaymentIntent creation, including the case where a reservation TTL has expired.

**Why it matters**: Checkout is the financial boundary before Stripe involvement. Bugs here could create PaymentIntents for expired reservations, charging users for stock that is no longer reserved.

---

| Case | Setup | Action | Assert | Type |
|---|---|---|---|---|
| C-1: Valid cart creates PaymentIntent | Order in DB (`status='reserved'`); reservation TTL key in Redis; Stripe mocked to return `{ clientSecret: 'test_secret' }` | `POST /product/create-payment-intent` | HTTP 200; `{ clientSecret: 'test_secret' }` in response; order `status` updated to `'payment_pending'` in DB | Integration |
| C-2: Expired reservation rejects checkout | Order in DB (`status='reserved'`); **no** reservation TTL key in Redis (expired/deleted) | `POST /product/create-payment-intent` | HTTP 400; order `status` remains `'reserved'`; Stripe mock never called | Integration |
| C-3: Unauthenticated request returns 401 | No auth cookie | `POST /product/create-payment-intent` | HTTP 401; no DB change; Stripe mock never called | Integration |

**Stripe mock pattern** used in checkout tests:
```js
import { vi } from "vitest";
vi.mock("stripe", () => ({
  default: vi.fn(() => ({
    paymentIntents: {
      create: vi.fn().mockResolvedValue({ client_secret: "test_secret" }),
    },
  })),
}));
```

---

## Path D — Webhook Fulfillment

**File**: `tests/integration/webhook.test.js`
**Minimum cases**: 4

**What it tests**: The Stripe webhook endpoint — signature verification, identity validation, and BullMQ job enqueueing. This is the security boundary between Stripe and the backend.

**Why it matters**: The webhook handler decides whether a purchase is processed. Bugs here can result in unpaid orders being fulfilled, paid orders being silently dropped, or the system being exploitable by replayed webhook events.

---

| Case | Setup | Action | Assert | Type |
|---|---|---|---|---|
| D-1: Valid webhook enqueues fulfillment job | Order in DB (`status='payment_pending'`); Stripe mock signs the event correctly; `purchaseQueue.add` spied | `POST /webhook-stripe` with valid signature | HTTP 200 `{ received: true }`; `purchaseQueue.add` called once with correct `orderId` | Integration |
| D-2: Invalid signature returns 400 | — | `POST /webhook-stripe` with tampered/missing `stripe-signature` header | HTTP 400; `purchaseQueue.add` never called | Integration |
| D-3: Metadata user_id mismatch returns 200 with no job | Order in DB (`user_id='alice'`); webhook metadata has `user_id='mallory'` | `POST /webhook-stripe` with valid signature but mismatched user | HTTP 200 (acknowledged); warning log emitted; `purchaseQueue.add` never called | Integration |
| D-4: Duplicate webhook does not enqueue twice | Order already in DB as `status='completed'`; same webhook event replayed | `POST /webhook-stripe` second time for same payment intent | HTTP 200; `purchaseQueue.add` called (job enqueued); **fulfillOrderProcessor** handles idempotency (see Path E) | Integration |

### Duplicate Webhook Test Design

```js
// D-4 uses vi.spyOn to count calls
const addSpy = vi.spyOn(purchaseQueue, "add");

await request.post("/webhook-stripe")...;  // first delivery
await request.post("/webhook-stripe")...;  // duplicate

// Webhook handler enqueues both times — idempotency is the processor's responsibility
expect(addSpy).toHaveBeenCalledTimes(2);
// Then Path E tests prove the processor handles it safely
```

---

## Path E — Fulfill Order Worker (Idempotency)

**File**: `tests/e2e/fulfillWorker.test.js`
**Minimum cases**: 3

**What it tests**: The `fulfillOrderProcessor` function — that it correctly transitions an order to `completed`, decrements PostgreSQL inventory, and is fully idempotent on duplicate calls.

**Why it matters**: The worker executes the permanent inventory decrement. A non-idempotent worker would decrement inventory multiple times per purchase, creating negative stock and financial loss.

---

| Case | Setup | Action | Assert | Type |
|---|---|---|---|---|
| E-1: Successful fulfillment completes order | Order in DB (`status='payment_pending'`, `product_id=1`); product inventory=5 | Call `fulfillOrderProcessor({ data: { orderId } })` | Order `status` = `'completed'`; `products.inventory` decremented by 1 (= 4); no error thrown | E2E |
| E-2: Duplicate call does not double-decrement | Order in DB already `status='completed'`; product inventory=4 | Call `fulfillOrderProcessor` again with same `orderId` | Order `status` still `'completed'`; `products.inventory` still 4 (unchanged); processor exits early with warning | E2E |
| E-3: Missing orderId throws immediately | — | Call `fulfillOrderProcessor({ data: {} })` | Throws an error; no DB changes made | E2E |

---

## Path F — Expiry Worker

**File**: `tests/e2e/expiresWorker.test.js`
**Minimum cases**: 4

**What it tests**: The `expiryProcessor` function — that it expires overdue `reserved` orders, restores Redis inventory, and leaves `payment_pending` orders untouched.

**Why it matters**: The expiry worker is the mechanism that prevents abandoned reservations from locking stock permanently. Bugs here mean stock never returns after a user abandons a checkout.

---

| Case | Setup | Action | Assert | Type |
|---|---|---|---|---|
| F-1: Expired reserved order is marked expired | Order in DB (`status='reserved'`, `expires_at` = 5 minutes ago); Redis inventory set to 0 | Call `expiryProcessor()` | Order `status` = `'expired'`; Redis `inventory:product-{id}` incremented by 1 (= 1); cart entry removed from `cart:user-{userId}` | E2E |
| F-2: Non-expired reserved order is ignored | Order in DB (`status='reserved'`, `expires_at` = 5 minutes in the future) | Call `expiryProcessor()` | Order `status` still `'reserved'`; Redis inventory unchanged | E2E |
| F-3: payment_pending order is not expired | Order in DB (`status='payment_pending'`, `expires_at` = 5 minutes ago) | Call `expiryProcessor()` | Order `status` still `'payment_pending'`; Redis inventory unchanged | E2E |
| F-4: Multiple expired orders all processed | 3 orders in DB (all `status='reserved'`, all past `expires_at`); Redis inventory = 0 | Call `expiryProcessor()` | All 3 orders `status` = `'expired'`; Redis inventory = 3; all cart entries removed | E2E |

### Expiry During Payment Test Design

```js
// F-3 specifically proves payment_pending is filtered out
const order = await seedOrder({
  status: "payment_pending",
  expires_at: new Date(Date.now() - 60000), // expired 1 minute ago
});

await expiryProcessor();

const result = await getPool().query(
  "SELECT status FROM orders WHERE id = $1", [order.id]
);
// Must still be payment_pending — expiry worker must not touch it
expect(result.rows[0].status).toBe("payment_pending");
```

---

## Path G — Authentication and RBAC

**File**: `tests/integration/auth.test.js`
**Minimum cases**: 5

**What it tests**: JWT issuance, cookie behaviour, and role-based access control enforcement on protected routes.

**Why it matters**: Incorrect RBAC allows standard users to access the admin dashboard, retry jobs, or cancel orders — all of which have financial and data integrity consequences.

---

| Case | Setup | Action | Assert | Type |
|---|---|---|---|---|
| G-1: Valid login issues JWT cookie | — | `POST /login` with valid customer credentials | HTTP 302 redirect; `Set-Cookie: token=...` header present; cookie has `HttpOnly` flag | Integration |
| G-2: Invalid credentials returns 401 | — | `POST /login` with wrong password | HTTP 401 or re-rendered login page with error; no `Set-Cookie` header | Integration |
| G-3: Authenticated request accesses protected route | Valid customer JWT cookie | `GET /product` (requires auth) | HTTP 200; page rendered correctly | Integration |
| G-4: Unauthenticated browser request redirects to login | No cookie | `GET /product` | HTTP 302 redirect to `/login` | Integration |
| G-5: Customer JWT cannot access admin route | Valid customer JWT (role: `'customer'`) | `GET /admin/dashboard` | HTTP 403 Forbidden | Integration |

---

## Path H — Rate Limiting

**File**: `tests/integration/rateLimiter.test.js`
**Minimum cases**: 3

**What it tests**: That the distributed Redis-backed rate limiter correctly enforces per-user request limits on the reservation endpoint.

**Why it matters**: Without rate limiting, a single user can exhaust inventory by spamming reservation requests, or trigger excessive Stripe API calls on the payment endpoint.

---

| Case | Setup | Action | Assert | Type |
|---|---|---|---|---|
| H-1: Requests within limit succeed | User authenticated; Redis flushed (clean rate limit state); product with inventory=15 | Send 10 successive `POST /product/:id/reserve` requests from the same user | All 10 return HTTP 200 (or 409 if inventory depleted — not 429) | Integration |
| H-2: Request exceeding limit returns 429 | Same user; Redis still holds the 10 previous hits from H-1 | Send 11th request | HTTP 429; response body contains `retryAfter` field | Integration |
| H-3: Different user is not affected by another user's limit | User A has hit their limit; User B is authenticated | User B sends `POST /product/:id/reserve` | HTTP 200 (or 409) — not 429; rate limits are per-user, not global | Integration |

---

## Path I — Health Endpoints

**File**: `tests/integration/health.test.js`
**Minimum cases**: 4

**What it tests**: The shape and correctness of the three observability endpoints.

**Why it matters**: Incorrect `/health` or `/ready` responses can cause load balancers to incorrectly route or restart healthy nodes, or fail to detect genuinely degraded ones.

---

| Case | Setup | Action | Assert | Type |
|---|---|---|---|---|
| I-1: /health returns correct shape | — | `GET /health` | HTTP 200; body has `status: "ok"`, `process`, `timestamp`, `uptime` fields; `uptime` is a number | Integration |
| I-2: /ready returns correct shape when healthy | Real Postgres + Redis connected | `GET /ready` | HTTP 200; body has `status: "ok"`; `checks.postgres.status = "ok"`; `checks.redis.status = "ok"`; `checks.bullmq.status = "ok"` | Integration |
| I-3: /metrics requires admin auth | No auth cookie | `GET /metrics` | HTTP 401 | Integration |
| I-4: /metrics returns correct shape for admin | Valid admin JWT cookie | `GET /metrics` | HTTP 200; body has `process`, `queue`, `inventory`, `redis_memory_mb` fields; `queue` has `waiting`, `active`, `failed` sub-fields | Integration |
