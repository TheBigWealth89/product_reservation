# Logging

The system uses [Winston](https://github.com/winstonjs/winston) for structured, level-filtered logging across all four processes. Every process instantiates the same logger from `src/utils/logger.js`.

---

## Configuration

**Source**: `src/utils/logger.js`

Winston is configured with a custom set of log levels, two file transports, and one console transport. The console transport is suppressed in production.

```js
import winston from "winston";

const logger = winston.createLogger({
  levels: {
    error: 0,
    warn:  1,
    info:  2,
    http:  3,
    debug: 4,
  },
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: "logs/error.log",    level: "error" }),
    new winston.transports.File({ filename: "logs/combined.log"               }),
  ],
});

if (process.env.NODE_ENV !== "production") {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    ),
  }));
}

export default logger;
```

---

## Log Levels

| Level | Priority | Console Colour | When to Use |
|---|---|---|---|
| `error` | 0 (highest) | Red | Unrecoverable errors: DB transaction failures, Redis connection loss, unhandled exceptions |
| `warn` | 1 | Yellow | Expected-but-notable events: duplicate webhook received, shutdown signal while already shutting down, idempotency skip |
| `info` | 2 | Green | Normal lifecycle events: server started, worker started, job processed, connection established |
| `http` | 3 | Magenta | Incoming HTTP request details (method, path, status, duration) |
| `debug` | 4 (lowest) | White | Verbose internal state: Lua script results, Redis key values, intermediate processing steps |

The active log level is set to `"debug"` in development (all messages logged) and `"info"` in production (debug and http messages suppressed in files). The console transport is not added at all in production — only the two file transports run.

---

## Transports

### `logs/error.log` — Errors Only

| Property | Value |
|---|---|
| Format | JSON (one object per line) |
| Level filter | `error` only |
| Purpose | Persistent error record; first file to check during incident response |

**Example entry**:
```json
{
  "level": "error",
  "message": "DB transaction failed during fulfillment",
  "orderId": 42,
  "error": "deadlock detected",
  "timestamp": "2026-05-13T20:31:00.123Z"
}
```

---

### `logs/combined.log` — All Levels

| Property | Value |
|---|---|
| Format | JSON (one object per line) |
| Level filter | All levels up to the configured maximum (`info` in prod, `debug` in dev) |
| Purpose | Full audit trail; used for debugging and replaying event sequences |

---

### Console — Development Only

| Property | Value |
|---|---|
| Format | Colourised, human-readable (`winston.format.simple()`) |
| Level filter | All levels (same as configured maximum) |
| Active in | `NODE_ENV !== 'production'` only |

The console transport is not added in production because Docker captures `stdout`/`stderr` which is then surfaced via `docker logs`. Keeping the production console clean reduces log noise; files provide the durable record.

---

## Log File Locations

Log files are written to the `logs/` directory inside each container. This directory is mounted as a **bind mount** in the Docker Compose files:

```yaml
volumes:
  - ./logs:/app/logs
```

This means `error.log` and `combined.log` are written to `product_reservation/logs/` on the host machine and persist across container restarts.

---

## Reading Logs in Production

### Via Docker (recommended — live tail)

```bash
# Tail all logs from the API server
docker logs -f prs-api-server

# Tail logs from a specific worker
docker logs -f prs-fulfill-worker
docker logs -f prs-expires-worker
docker logs -f prs-cleanup-worker

# Show last 100 lines
docker logs --tail 100 prs-api-server
```

### Via log files (structured JSON)

```bash
# Tail the combined log (all levels)
tail -f logs/combined.log

# Filter errors only
tail -f logs/error.log

# Pretty-print with jq
tail -f logs/combined.log | jq '.'

# Filter by level
tail -f logs/combined.log | jq 'select(.level == "error")'

# Filter by a specific field
tail -f logs/combined.log | jq 'select(.orderId == 42)'
```

---

## Level Filtering Summary

| Transport | Development | Production |
|---|---|---|
| `logs/error.log` | `error` only | `error` only |
| `logs/combined.log` | All levels (debug → error) | `info`, `warn`, `error` |
| Console | All levels (colourised) | Not active |
