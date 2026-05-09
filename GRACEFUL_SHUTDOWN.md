# Graceful Shutdown

> **Added**: 2026-05-09 | Applies to: API Server, Fulfill Order Worker, Expires Worker, Cleanup Worker

---

## Why This Matters

When Docker stops a container (scale-down, deploy, `docker-compose down`) it sends **SIGTERM**. Without a handler, Node.js exits immediately — potentially mid-database-transaction. This leaves:

- Open PostgreSQL transactions (no ROLLBACK) → data inconsistency.
- Leaked DB pool connections.
- Orphaned BullMQ jobs stuck in "active" state.
- Redis connections not cleanly closed.

---

## Architecture

### Shared Utility — `src/utils/shutdown.js`

A single async helper used by all four processes. Each caller passes only the handles it owns.

```
registerShutdownHandlers(opts)
│
├── process.on("SIGTERM")   ─┐
├── process.on("SIGINT")    ─┼─ double-invocation guard (isShuttingDown flag)
└── process.on("unhandledRejection") ─┘
         │
         └── gracefulShutdown(opts)
               │
               ├── 1. await stopTimer()         (clearInterval / cron.stop)
               ├── 2. io.close()                (Socket.IO — before HTTP server)
               ├── 3. httpServer.close()         (stop new TCP connections)
               ├── 4. worker.close()            (drain in-flight BullMQ job, 20s timeout)
               ├── 5. queue.close()             (close BullMQ queue connection)
               ├── 6. dbPool.end()              (release all Postgres clients)
               └── 7. redisClient.quit()        (clean Redis disconnect)
               │
               └── Promise.race(doShutdown, 25s hard timeout)
                     ├── success → process.exit(0)
                     └── timeout → process.exit(1)  (before Docker's 30s SIGKILL)
```

### Timeout Layering

| Layer | Timeout | Purpose |
|-------|---------|---------|
| `worker.close()` inner race | **20 s** | Prevents a hung BullMQ job from blocking forever |
| `gracefulShutdown` outer race | **25 s** | Catches any other hung step |
| `docker-compose stop_grace_period` | **30 s** | Docker sends SIGKILL if process is still alive |

This 20s → 25s → 30s ladder ensures the process always exits before Docker force-kills it, with 5-second buffers at each level.

---

## Per-Process Details

### API Server (`src/server.js`)

```
SIGTERM/SIGINT
  ↓
io.close()          — disconnect all Socket.IO clients
  ↓
httpServer.close()  — stop accepting new HTTP requests
  ↓
dbPool.end()        — release all Postgres pool clients
  ↓
redisClient.quit()  — clean Redis disconnect
```

**Key prerequisite**: `initSockets()` in `src/sockets/index.js` now returns the `io` instance so `server.js` can pass it to the shutdown handler.

---

### Fulfill Order Worker (`src/workers/fulfillOrderWorker.js`)

```
SIGTERM/SIGINT
  ↓
worker.close()      — BullMQ waits for current job processor to resolve/reject
                      If the processor throws, the existing catch block issues
                      ROLLBACK before re-throwing → transaction rolls back cleanly
  ↓
dbPool.end()
  ↓
redisClient.quit()
```

**Key fix**: The `Worker` instance is now stored in a `const worker` variable so `worker.close()` can be called. Previously `new Worker(...)` was fire-and-forget — impossible to drain.

---

### Expires Worker (`src/workers/expiresWorker.js`)

```
SIGTERM/SIGINT
  ↓
cleanup.stop()
  ├── clearInterval(this.timer)     — no new poll cycles
  └── await this._runningPromise    — waits for any in-flight cleanupExpired()
                                      call to finish its DB transaction
  ↓
dbPool.end()
  ↓
redisClient.quit()
```

**Key fix**: `_runningPromise` tracks the active `_doCleanup()` call. Without this, the DB pool could be closed while a transaction is open, causing a connection-released error and a missed ROLLBACK.

---

### Cleanup Worker (`src/workers/cleanupWorker.js`)

```
SIGTERM/SIGINT
  ↓
task.stop()         — stops the node-cron schedule (no new ticks)
  ↓
queue.close()       — closes BullMQ queue connection
  ↓
dbPool.end()
  ↓
redisClient.quit()
```

**Note on the Redis lock**: `runCleanup` always releases `cleanup-lock` in its `finally` block. If SIGTERM arrives between cron ticks, the lock was never acquired. If SIGTERM arrives mid-run, `finally` fires and releases the lock before the pool closes.

---

## Double-Invocation Guard

```js
let isShuttingDown = false;
const handler = (signal) => {
  if (isShuttingDown) { logger.warn("...already shutting down, ignoring"); return; }
  isShuttingDown = true;
  gracefulShutdown(opts);
};
```

Pressing Ctrl+C twice (or SIGTERM + SIGINT) logs a warning and does nothing instead of starting a second shutdown sequence.

---

## Files Changed

| File | Change |
|------|--------|
| `src/utils/shutdown.js` | **Created** — shared shutdown helper |
| `src/sockets/index.js` | `initSockets()` now returns `io` |
| `src/server.js` | Captures `io`; calls `registerShutdownHandlers` |
| `src/workers/fulfillOrderWorker.js` | Captures `worker`; calls `registerShutdownHandlers` |
| `src/workers/expiresWorker.js` | Adds `_runningPromise`, `stop()`, `registerShutdownHandlers` |
| `src/workers/cleanupWorker.js` | Captures `task`; calls `registerShutdownHandlers` |
| `docker-compose.yml` | Adds `stop_grace_period: 30s` to all 4 services |

---

## Testing Graceful Shutdown

```bash
# 1. Start all containers
docker-compose up --build

# 2. Generate some in-flight work (e.g. trigger a reservation + payment)

# 3. Stop a specific container gracefully
docker-compose stop prs-fulfill-worker

# 4. Watch the logs — you should see the shutdown sequence
docker logs prs-fulfill-worker

# Expected output:
# [Fulfill Order Worker] Shutdown signal received — starting graceful shutdown
# [Fulfill Order Worker] BullMQ worker drained
# [Fulfill Order Worker] DB pool closed
# [Fulfill Order Worker] Redis disconnected
# [Fulfill Order Worker] Graceful shutdown complete ✅

# 5. Verify no orphaned Postgres connections
psql $DATABASE_URL -c "SELECT pid, state, query FROM pg_stat_activity WHERE datname = 'reservation_system_iv2b';"
```

---

## Signals Handled

| Signal | Source | Behaviour |
|--------|--------|-----------|
| `SIGTERM` | `docker stop` / `docker-compose stop` | Triggers graceful shutdown |
| `SIGINT` | `Ctrl+C` in local dev | Triggers graceful shutdown |
| `unhandledRejection` | Uncaught Promise rejection | Logs error, triggers graceful shutdown |
