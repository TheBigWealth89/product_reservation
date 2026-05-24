# Fault Tolerance Patterns

Every defensive pattern in this system is deliberate. This document explains each pattern: what failure mode it prevents, where it is implemented, and why that specific approach was chosen over alternatives.

For the graceful shutdown implementation specifically, see [../operations/shutdown.md](../operations/shutdown.md).

---

## Pattern Summary Table

| Pattern | Implementation | Location |
|---|---|---|
| Atomic operations | Redis Lua scripts | `decrement_inventory.lua`, `validate_cart.lua` |
| Distributed rate limiting | `express-rate-limit` + Redis store | `middleware/rateLimiter.js` |
| Idempotent processing | Status check before fulfillment | `workers/processors/fulfillOrderProcessor.js` |
| Row-level locking | `SELECT ... FOR UPDATE` | `fulfillOrderWorker.js`, `admin.js` |
| Skip locked rows | `FOR UPDATE SKIP LOCKED` | `workers/processors/expiryProcessor.js` |
| Compensation logic | Revert to `reserved` on payment failure | `routes/products.js` |
| Distributed locking | Redis `SET NX EX` | `workers/processors/cleanupProcessor.js` |
| Automatic retry | BullMQ 3 attempts, 1s backoff | `routes/webhook.js` job config |
| Webhook retries | Return `500` on processing failure | `routes/webhook.js` |
| Identity validation | Stripe metadata vs DB user ID | `routes/webhook.js` |
| Graceful degradation | Sync failure does not block startup | `src/server.js` |

---

## Atomic Operations — Redis Lua Scripts

**What it protects against**: Race conditions where two concurrent requests both read the inventory counter, both see a positive value, and both decrement it — resulting in inventory going below zero (overselling).

**Where it is implemented**: `decrement_inventory.lua` (called at reservation time) and `validate_cart.lua` (called at checkout time).

**Why this approach**: Redis executes Lua scripts atomically inside its single-threaded event loop. No other command can run between the GET and the DECR inside the script. This is cheaper and faster than a PostgreSQL row lock for the high-frequency reservation operation. A database `SELECT ... FOR UPDATE` would work but serialises all reservation attempts on the same row, creating a queue of waiting connections that degrades throughput under load.

---

## Distributed Rate Limiting

**What it protects against**: A single authenticated user spamming the reservation or checkout endpoint to exhaust inventory, trigger excessive Stripe API calls, or cause denial-of-service for other users.

**Where it is implemented**: `middleware/rateLimiter.js` — two limiters: `reserveLimiter` (10 requests per 15 minutes) and `paymentLimiter` (3 requests per 1 minute). Rate limit state is stored in Redis, keyed by the authenticated user's ID (extracted from the JWT), not by IP address.

**Why this approach**: IP-based rate limiting is easy to bypass (VPNs, NAT). Keying on the authenticated user ID means the limit follows the account, not the network. Redis is used as the store so the limit works correctly across all API server replicas — a per-process in-memory counter would allow each replica to receive its own full quota.

The `/health` route is explicitly excluded from rate limiting so that load-balancer probes are never blocked.

---

## Idempotent Processing

**What it protects against**: Stripe may deliver the same `payment_intent.succeeded` webhook more than once (network retries, Stripe's at-least-once delivery guarantee). Without a guard, `fulfillOrderWorker` would decrement `products.inventory` multiple times for a single purchase, corrupting the stock count.

**Where it is implemented**: `fulfillOrderProcessor.js` — before any database write, the processor queries the order's current `status`. If it is already `'completed'`, the processor logs a warning and exits without making any changes.

**Why this approach**: The idempotency check is inside a `BEGIN ... FOR UPDATE` transaction, meaning the check and any subsequent write are atomic at the database level. A check outside the transaction would still allow a race between two concurrent duplicate jobs passing the check before either commits.

---

## Row-Level Locking — `SELECT ... FOR UPDATE`

**What it protects against**: Two concurrent processes (e.g. two fulfillOrderWorker replicas) both reading the same order row and both deciding to fulfil it, leading to a double inventory decrement.

**Where it is implemented**: `fulfillOrderProcessor.js` and `admin.js` (cancel endpoint). Both open a `BEGIN` transaction and immediately issue `SELECT ... FOR UPDATE` on the order row before reading its status or writing any changes.

**Why this approach**: `FOR UPDATE` acquires an exclusive row lock. Any other transaction that also issues `SELECT ... FOR UPDATE` on the same row must wait until the first transaction commits or rolls back. This prevents the double-fulfil scenario even when multiple worker instances run simultaneously.

---

## Skip Locked Rows — `FOR UPDATE SKIP LOCKED`

**What it protects against**: Multiple `expiresWorker` processes (or rapid consecutive poll cycles) attempting to expire the same order row simultaneously. Without skipping, each would block on the row lock held by the other, serialising all expiration work.

**Where it is implemented**: `expiryProcessor.js` — `SELECT * FROM orders WHERE expires_at < NOW() AND status = 'reserved' FOR UPDATE SKIP LOCKED`.

**Why this approach**: `SKIP LOCKED` causes the query to simply ignore any rows that are currently locked by another transaction, rather than waiting for the lock to be released. This allows concurrent expiry processors to each claim a non-overlapping subset of expired rows and process them in parallel, without deadlock risk.

---

## Compensation Logic — Revert to `reserved` on Payment Failure

**What it protects against**: A user's card is declined after the order has already been moved to `payment_pending`. Without compensation, the order stays in `payment_pending` indefinitely, blocking the `expiresWorker` from reclaiming the stock (the expiry worker specifically ignores `payment_pending` orders to avoid interfering with active payment flows).

**Where it is implemented**: `routes/products.js` — in the `POST /product/create-payment-intent` error handler. If the Stripe PaymentIntent creation fails, the handler reverts the order status from `payment_pending` back to `reserved` so the expiry worker can eventually clean it up.

**Why this approach**: This is a compensating transaction — rolling back a business-level state change when a downstream operation fails. The alternative (leaving the order in `payment_pending` and letting it time out via the cleanup worker) would require the cleanup worker to also handle the revert logic, and the stock would be locked for the full cleanup interval rather than immediately recoverable.

---

## Distributed Locking — Redis `SET NX EX`

**What it protects against**: Multiple `cleanupWorker` replicas (or rapid cron ticks of the same process) running the cleanup logic simultaneously, causing duplicate `returnStock()` calls and duplicate `job.remove()` operations.

**Where it is implemented**: `cleanupProcessor.js` — `SET cleanup-lock running NX EX 300`. `NX` means the key is only set if it does not already exist (atomic compare-and-set). `EX 300` sets a 300-second TTL so the lock automatically expires if the process crashes mid-cleanup.

**Why this approach**: Redis `SET NX` is atomic — exactly one caller wins the race to set the key. All others see a `null` return and skip the cleanup cycle. The lock is always released in a `finally` block so it is freed even if the cleanup throws. The TTL is a safety net against the `finally` block being unreachable (e.g. `process.kill -9`).

---

## Automatic Retry — BullMQ Job Configuration

**What it protects against**: Transient database failures (connection timeout, deadlock, brief outage) during order fulfillment. Without retries, a single transient error would permanently fail the job and the order would never be fulfilled.

**Where it is implemented**: `routes/webhook.js` — `purchaseQueue.add('fulfill-order', data, { attempts: 3, backoff: { type: 'fixed', delay: 1000 }, removeOnComplete: true, removeOnFail: false })`.

**Why this approach**: Three attempts with a 1-second fixed backoff covers the typical case of a brief database blip. `removeOnFail: false` keeps failed jobs visible in the BullMQ failed queue so the admin dashboard can surface them for manual review or retry. `removeOnComplete: true` keeps the queue tidy for jobs that succeed without operator intervention.

---

## Webhook Retries — Return `500` on Processing Failure

**What it protects against**: An unexpected error (database unavailable, code bug) in the webhook handler causing the order to never be enqueued for fulfillment, silently losing the purchase.

**Where it is implemented**: `routes/webhook.js` — uncaught errors in the handler return HTTP `500`.

**Why this approach**: Stripe treats any non-2xx response as a signal to retry the webhook automatically, with exponential backoff, for up to 3 days. By returning `500` on a genuine processing error, the system delegates retry responsibility to Stripe's infrastructure rather than requiring the operator to manually re-trigger the webhook. This is why the webhook handler must be careful to return `200` in cases where retrying would not help (e.g. a metadata mismatch).

---

## Identity Validation — Stripe Metadata vs DB User ID

**What it protects against**: An attacker intercepting or replaying a Stripe webhook to trigger fulfillment of an order belonging to a different user.

**Where it is implemented**: `routes/webhook.js` — after verifying the webhook signature, the handler queries the database for the order using the `payment_intent_id` from the event and compares the database `user_id` with `event.data.object.metadata.user_id`.

**Why this approach**: The webhook signature verification (via `STRIPE_WEBHOOK_SECRET`) already proves the event came from Stripe and was not tampered with in transit. The identity check is a second layer that detects data integrity issues: if the metadata embedded at PaymentIntent creation time does not match the database record, something has gone wrong that warrants aborting without fulfillment. The handler returns `200` (not `500`) to prevent Stripe from retrying an event that cannot be safely processed.

---

## Graceful Degradation — Startup Inventory Sync

**What it protects against**: A Redis connectivity problem at startup time blocking the entire API server from starting, making the system completely unavailable even though HTTP routes could otherwise function.

**Where it is implemented**: `src/server.js` — the `syncInventoryToRedis()` call is wrapped so that a failure logs a warning but does not throw, allowing `app.listen()` to proceed.

**Why this approach**: The inventory sync is a best-effort optimisation (ensuring Redis has accurate counts on cold start). If it fails, Redis may have stale or empty inventory counters until the sync can be re-run or the process restarts. This is a recoverable state — far better than a total server outage. The tradeoff is accepted explicitly and logged so operators are aware.
