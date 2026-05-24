# Workers

This document covers the three background worker processes: why they exist as separate processes, what each one does internally, and how the processor extraction refactor enables testability.

For how to run each worker, see [setup.md](setup.md). For graceful shutdown behaviour per worker, see [../operations/shutdown.md](../operations/shutdown.md).

---

## Why Workers Are Separate Processes

The three workers (`fulfillOrderWorker`, `expiresWorker`, `cleanupWorker`) each run as an independent Node.js process rather than as tasks inside the API server. The reasons are:

1. **Crash isolation** — A bug in the cleanup worker that causes an unhandled rejection does not bring down the HTTP server. Each process fails independently.
2. **Independent scaling** — In a high-traffic environment, `fulfillOrderWorker` can be replicated across multiple machines without duplicating the API server or the polling worker.
3. **Clean `SIGTERM` handling** — Docker can stop a single worker container without touching the rest of the application. Each process receives its own signal and executes its own shutdown sequence.
4. **Memory isolation** — Long-running PostgreSQL transactions in the fulfill worker do not affect the memory or event loop latency of the API server.

---

## Processor Extraction — `src/workers/processors/`

Each worker file (`fulfillOrderWorker.js`, `expiresWorker.js`, `cleanupWorker.js`) originally contained both the process infrastructure (BullMQ worker setup, cron schedule, signal handlers) and the core business logic (the SQL queries and Redis operations).

To make the business logic testable without fighting BullMQ timing or `node-cron` scheduling, the data-processing code was extracted into separate **processor functions** in `src/workers/processors/`:

| Processor File | Exports | Called By |
|---|---|---|
| `processors/fulfillOrderProcessor.js` | `fulfillOrderProcessor(job)` | `fulfillOrderWorker.js` BullMQ job handler |
| `processors/expiryProcessor.js` | `expiryProcessor()` | `expiresWorker.js` poll interval handler |
| `processors/cleanupProcessor.js` | `cleanupProcessor()` | `cleanupWorker.js` cron tick handler |

The worker files now act as thin process wrappers: they set up the queue/cron/interval, register signal handlers, and pass control to the processor. The E2E tests import the processor functions directly and call them with controlled arguments, asserting the resulting database and Redis state without running the actual worker process.

---

## `fulfillOrderWorker` — BullMQ Queue Worker

**File**: `src/workers/fulfillOrderWorker.js`
**Processor**: `src/workers/processors/fulfillOrderProcessor.js`

### Trigger

The `fulfill-order` BullMQ job is added to the queue by `routes/webhook.js` when Stripe fires a `payment_intent.succeeded` event and identity validation passes.

### Queue Configuration

```js
new Worker("fulfill-order", fulfillOrderProcessor, { connection: redisClient });
```

| Option | Value | Reason |
|---|---|---|
| Queue name | `fulfill-order` | Matches the queue defined in `purchaseQueue.js` |
| Job attempts | `3` | Covers transient DB failures without losing the purchase |
| Backoff type | `fixed` | 1 second delay between retries |
| `removeOnComplete` | `true` | Keeps the queue clean; completed jobs need no further action |
| `removeOnFail` | `false` | Failed jobs stay visible in the BullMQ failed queue for admin review |

### Processing Logic (Step by Step)

1. Extract `orderId` from `job.data`. If missing, throw immediately (invalid job).
2. `BEGIN` a PostgreSQL transaction.
3. `SELECT id, status, product_id FROM orders WHERE id = $1 FOR UPDATE` — acquires an exclusive row lock, blocking any concurrent processor that tries to fulfill the same order.
4. **Idempotency check**: if `order.status === 'completed'`, log a warning and `COMMIT` (no-op). This handles Stripe duplicate webhook delivery.
5. `UPDATE products SET inventory = inventory - 1 WHERE id = $1` — permanent decrement of PostgreSQL inventory.
6. `UPDATE orders SET status = 'completed', updated_at = NOW() WHERE id = $1`.
7. `COMMIT`.
8. On any error: `ROLLBACK` + re-throw so BullMQ marks the attempt as failed and schedules a retry.

### Failure Handling

- **Retry**: BullMQ automatically retries up to 3 times. The existing `ROLLBACK` in the catch block ensures no partial write is committed before a retry.
- **Permanent failure**: After 3 failed attempts, the job moves to the BullMQ failed queue. `cleanupWorker` and the admin dashboard surface these for manual intervention.

---

## `expiresWorker` — Polling Worker

**File**: `src/workers/expiresWorker.js`
**Processor**: `src/workers/processors/expiryProcessor.js`

### Type and Interval

This is a **polling-based** worker. It runs `expiryProcessor()` on a fixed interval of **30 seconds** using `setInterval`. It is not event-driven — it wakes up, checks the database, and goes back to sleep.

### Concurrency Guard

```js
class ExpirationCleanup {
  constructor() {
    this.isRunning = false;
    this._runningPromise = null;
    this.timer = null;
  }
}
```

`this.isRunning` prevents overlapping executions. If the 30-second interval fires while the previous poll cycle is still processing rows (e.g. due to a slow database), the new tick is skipped entirely.

`this._runningPromise` tracks the active `_doCleanup()` call. During graceful shutdown, the shutdown handler calls `cleanup.stop()` which:
1. Calls `clearInterval(this.timer)` — no new poll cycles.
2. Awaits `this._runningPromise` — waits for any in-flight cycle to finish its database transaction before allowing the pool to close.

### Processing Logic (Step by Step)

1. `BEGIN` a PostgreSQL transaction.
2. `SELECT * FROM orders WHERE expires_at < NOW() AND status = 'reserved' FOR UPDATE SKIP LOCKED` — finds expired orders and locks them; skips any rows already locked by a concurrent process.
3. For each expired order:
   - `UPDATE orders SET status = 'expired', updated_at = NOW() WHERE id = $1`
   - Call `returnStock(product_id)` — atomically `INCR` the Redis inventory counter and publish to `inventory-updates`.
   - `SREM cart:user-{userId}` — remove the cart entry.
4. `COMMIT`.
5. On error: `ROLLBACK`.

### Why `FOR UPDATE SKIP LOCKED`?

If multiple `expiresWorker` replicas run simultaneously (or if a previous poll cycle is still running when the next one starts without the guard), they would try to expire the same rows. `SKIP LOCKED` causes each process to claim only unlocked rows — they each get a non-overlapping subset. This prevents duplicate `returnStock()` calls on the same order, which would incorrectly over-increment the Redis inventory counter.

---

## `cleanupWorker` — Cron Worker

**File**: `src/workers/cleanupWorker.js`
**Processor**: `src/workers/processors/cleanupProcessor.js`

### Type and Schedule

This is a **cron-based** worker using `node-cron`. It fires every **10 seconds** (`*/10 * * * * *`).

### Distributed Lock Mechanism

Before doing any work, the processor acquires a Redis lock:

```js
const acquired = await redisClient.set("cleanup-lock", "running", "NX", "EX", 300);
if (!acquired) return; // another instance is running — skip this tick
```

- `NX` — only set the key if it does not already exist (atomic compare-and-set).
- `EX 300` — key auto-expires after 300 seconds (safety net if the process crashes with the lock held).

The lock is **always released in a `finally` block**:

```js
try {
  // cleanup logic
} finally {
  await redisClient.del("cleanup-lock");
}
```

This ensures the lock is released even if the cleanup logic throws, preventing indefinite lock-holding.

### Processing Logic (Step by Step)

1. Attempt to acquire `cleanup-lock` in Redis. If `null` is returned, another instance holds the lock — return immediately.
2. `purchaseQueue.getFailed()` — retrieve all failed BullMQ jobs from the `fulfill-order` queue.
3. For each failed job:
   - `UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND status != 'completed'` — the `AND status != 'completed'` guard prevents accidentally cancelling a job that was fulfilled by a separate retry between the time it moved to failed and the cleanup ran.
   - Call `returnStock(product_id)` — restore Redis inventory.
   - `job.remove()` — clean the job from the BullMQ failed queue.
4. Release `cleanup-lock` in `finally`.

### How to Run Each Worker

**Development** (with Nodemon/watch restart on file changes):
```bash
npm run dev:fulfillOrderWorker
npm run dev:expiresWorker
npm run dev:cleanupWorker
```

**Production** (stable, no file watching):
```bash
npm run start:fulfillOrderWorker
npm run start:expiresWorker
npm run start:cleanupWorker
```

**Via Docker Compose (recommended)**:
```bash
# All workers start automatically with the local stack
docker compose -f docker-compose.local.yml up --watch
```
