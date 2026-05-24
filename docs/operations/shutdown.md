# Graceful Shutdown

> Added: 2026-05-09 | Applies to: API Server, fulfillOrderWorker, expiresWorker, cleanupWorker

All four Node.js processes handle `SIGTERM` and `SIGINT` signals, draining in-flight work and closing connections before exiting. Without this, a `docker stop` or `Ctrl+C` could kill a process mid-transaction.

---

## Why This Matters

When Docker stops a container it sends **SIGTERM**. Without a handler, Node.js exits immediately. Depending on what the process was doing at that moment, this leaves:

- **Open PostgreSQL transactions** with no `ROLLBACK` — data inconsistency and locked rows.
- **Leaked DB pool connections** — the pool client is released back to PostgreSQL only when the connection closes cleanly.
- **Orphaned BullMQ jobs** stuck in "active" state — the job never resolves or rejects, so BullMQ cannot move it to completed or failed. It blocks the queue.
- **Redis connections not closed** — ioredis clients go into a reconnect loop after the remote end drops the TCP connection, generating noise in Redis server logs.

---

## Architecture

### Shared Utility — `src/utils/shutdown.js`

A single async helper used by all four processes. Each caller passes only the handles it owns (API server passes `io` and `httpServer`; workers pass `worker` or `task`).

```
registerShutdownHandlers(opts)
│
├── process.on("SIGTERM")              ─┐
├── process.on("SIGINT")               ─┼─ double-invocation guard (isShuttingDown flag)
└── process.on("unhandledRejection")   ─┘
         │
         └── gracefulShutdown(opts)
               │
               ├── 1. await stopTimer()         (clearInterval / cron.stop)
               ├── 2. io.close()                (Socket.IO — disconnect clients before HTTP)
               ├── 3. httpServer.close()         (stop accepting new TCP connections)
               ├── 4. worker.close()            (drain in-flight BullMQ job, 20s timeout)
               ├── 5. queue.close()             (close BullMQ queue connection)
               ├── 6. dbPool.end()              (release all Postgres clients)
               └── 7. redisClient.quit()        (clean Redis disconnect)
               │
               └── Promise.race(doShutdown(), 25s hard timeout)
                     ├── success → process.exit(0)
                     └── timeout → process.exit(1)  ← before Docker's 30s SIGKILL
```

---

## Timeout Layering

| Layer | Timeout | Purpose |
|---|---|---|
| `worker.close()` inner race | **20 s** | Prevents a hung BullMQ job processor from blocking shutdown indefinitely |
| `gracefulShutdown` outer race | **25 s** | Catches any other hung step (pool drain, Redis quit) |
| `docker-compose stop_grace_period` | **30 s** | Docker sends SIGKILL if the process is still alive after this |

The 20 s → 25 s → 30 s ladder guarantees the process always exits cleanly before Docker force-kills it. Each level has a 5-second buffer above the one below it.

---

## Per-Process Shutdown Sequences

### API Server (`src/server.js`)

```
SIGTERM / SIGINT
  ↓
io.close()           — disconnect all Socket.IO clients, stop accepting WebSocket upgrades
  ↓
httpServer.close()   — stop accepting new HTTP connections (in-flight requests finish)
  ↓
dbPool.end()         — release all PostgreSQL pool clients
  ↓
redisClient.quit()   — send QUIT command; Redis closes the connection cleanly
  ↓
process.exit(0)
```

**Key prerequisite**: `initSockets()` in `src/sockets/index.js` returns the `io` instance so `server.js` can pass it to the shutdown handler. Without the return value, `io.close()` cannot be called.

---

### fulfillOrderWorker (`src/workers/fulfillOrderWorker.js`)

```
SIGTERM / SIGINT
  ↓
worker.close()       — BullMQ waits for the current job processor to resolve or reject
                       (20s inner timeout)
                       If the processor throws, the existing catch block issues
                       ROLLBACK before re-throwing → transaction rolls back cleanly
  ↓
dbPool.end()
  ↓
redisClient.quit()
  ↓
process.exit(0)
```

**Key fix**: The `Worker` instance is stored in a `const worker` variable so `worker.close()` can be called on it. Previously `new Worker(...)` was fire-and-forget — impossible to drain cleanly.

---

### expiresWorker (`src/workers/expiresWorker.js`)

```
SIGTERM / SIGINT
  ↓
cleanup.stop()
  ├── clearInterval(this.timer)     — no new poll cycles will start
  └── await this._runningPromise    — waits for any in-flight _doCleanup()
                                      call to finish its DB transaction
  ↓
dbPool.end()
  ↓
redisClient.quit()
  ↓
process.exit(0)
```

**Key fix**: `_runningPromise` tracks the active `_doCleanup()` call. Without it, the DB pool could be closed while a transaction is mid-flight, causing a `connection released while query is running` error and a missed `ROLLBACK`.

---

### cleanupWorker (`src/workers/cleanupWorker.js`)

```
SIGTERM / SIGINT
  ↓
task.stop()          — stops the node-cron schedule (no new ticks)
  ↓
queue.close()        — closes the BullMQ queue connection
  ↓
dbPool.end()
  ↓
redisClient.quit()
  ↓
process.exit(0)
```

**Note on the Redis lock**: `runCleanup` always releases `cleanup-lock` in its `finally` block. If SIGTERM arrives between cron ticks, the lock was never acquired — nothing to release. If SIGTERM arrives mid-run, `finally` fires and releases the lock before the pool closes.

---

## Double-Invocation Guard

Pressing Ctrl+C twice, or receiving both SIGTERM and SIGINT in rapid succession, must not start a second parallel shutdown sequence.

```js
let isShuttingDown = false;

const handler = (signal) => {
  if (isShuttingDown) {
    logger.warn(`[${processName}] Already shutting down — ignoring signal ${signal}`);
    return;
  }
  isShuttingDown = true;
  gracefulShutdown(opts);
};

process.on("SIGTERM", handler);
process.on("SIGINT",  handler);
process.on("unhandledRejection", (reason) => {
  logger.error(`[${processName}] Unhandled rejection`, { reason });
  handler("unhandledRejection");
});
```

The second signal logs a warning and returns immediately. Only one shutdown sequence ever runs.

---

## Files Changed

| File | Change |
|---|---|
| `src/utils/shutdown.js` | **Created** — shared `registerShutdownHandlers` + `gracefulShutdown` utility |
| `src/sockets/index.js` | `initSockets()` now returns the `io` instance |
| `src/server.js` | Captures `io` return value; calls `registerShutdownHandlers` |
| `src/workers/fulfillOrderWorker.js` | Captures `worker` in `const`; calls `registerShutdownHandlers` |
| `src/workers/expiresWorker.js` | Adds `_runningPromise` tracking, `stop()` method, `registerShutdownHandlers` |
| `src/workers/cleanupWorker.js` | Captures `task` from `cron.schedule()`; calls `registerShutdownHandlers` |
| `docker-compose.yml` | Adds `stop_grace_period: 30s` to all 4 services |
| `docker-compose.local.yml` | Adds `stop_grace_period: 30s` to all 4 application services |

---

## Testing Graceful Shutdown

```bash
# 1. Start all containers
docker compose -f docker-compose.local.yml up --build

# 2. Generate in-flight work (trigger a reservation + payment flow)

# 3. Stop a specific container gracefully
docker compose -f docker-compose.local.yml stop prs-local-fulfill-worker

# 4. Watch the shutdown sequence in the logs
docker logs prs-local-fulfill-worker
```

**Expected log output**:
```
[Fulfill Order Worker] Shutdown signal received — starting graceful shutdown
[Fulfill Order Worker] BullMQ worker drained
[Fulfill Order Worker] DB pool closed
[Fulfill Order Worker] Redis disconnected
[Fulfill Order Worker] Graceful shutdown complete ✅
```

**Verify no orphaned PostgreSQL connections**:
```bash
psql $DATABASE_URL -c \
  "SELECT pid, state, query FROM pg_stat_activity WHERE datname = 'your_db_name';"
```

After a clean shutdown, no rows should appear with `state = 'idle in transaction'`.

---

## Signals Handled

| Signal | Source | Behaviour |
|---|---|---|
| `SIGTERM` | `docker stop` / `docker compose stop` | Triggers graceful shutdown sequence |
| `SIGINT` | `Ctrl+C` in local terminal | Triggers graceful shutdown sequence |
| `unhandledRejection` | Uncaught Promise rejection anywhere in the process | Logs the error, then triggers graceful shutdown |
