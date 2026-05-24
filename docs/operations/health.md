# Health and Observability Endpoints

The API server exposes three endpoints for monitoring. They are designed for different consumers: `/health` for container orchestrators, `/ready` for load balancers, and `/metrics` for operators and incident response.

---

## `GET /health` — Liveness Probe

**Purpose**: Confirms the Node.js process is alive and the event loop is not blocked. Used by Docker, Kubernetes, or any orchestrator to decide whether to restart the container.

**Authentication**: None (public).

**Dependencies checked**: None. This endpoint intentionally does not ping PostgreSQL or Redis. If an external dependency is temporarily down, the process itself is still healthy — restarting it will not fix a database outage and will only cause service interruption.

**Expected latency**: Under 5 ms in all environments (no I/O).

**Response** — always HTTP `200`:

```json
{
  "status": "ok",
  "process": "api-server",
  "timestamp": "2026-05-13T20:31:00.000Z",
  "uptime": 120.5
}
```

| Field | Type | Description |
|---|---|---|
| `status` | `"ok"` | Always `"ok"` — this endpoint never returns a non-200 |
| `process` | string | Identifies which process is responding |
| `timestamp` | ISO 8601 string | Current UTC time |
| `uptime` | number | Process uptime in seconds (`process.uptime()`) |

**Production use**: Configure your orchestrator's liveness probe on this endpoint with a short interval (e.g. every 10 s) and a low threshold (e.g. 3 consecutive failures = restart).

---

## `GET /ready` — Readiness Probe

**Purpose**: Confirms the application is fully connected and ready to handle traffic. Used by load balancers to route requests away from nodes that are starting up or have lost connectivity to their backing services.

**Authentication**: None (public).

**Dependencies checked**: PostgreSQL (simple `SELECT 1` query), Redis (`PING` command), BullMQ (queue `getJobCounts()` call). All three checks run in **parallel** via `Promise.allSettled`, so the total response time equals the slowest single check — not their sum.

**Expected latency**: Under 5 ms on localhost; 200–400 ms against remote cloud databases due to network round-trip.

> If you observe `/ready` returning in 200–400 ms, this is normal when connecting to cloud-hosted PostgreSQL or Redis — it reflects the network latency to the remote service, not a problem with the application.

**Response — HTTP `200` (all dependencies healthy)**:

```json
{
  "status": "ok",
  "process": "api-server",
  "timestamp": "2026-05-13T20:31:00.000Z",
  "uptime": 120.5,
  "checks": {
    "postgres": { "status": "ok", "latency_ms": 4 },
    "redis":    { "status": "ok", "latency_ms": 1 },
    "bullmq":   {
      "status": "ok",
      "latency_ms": 2,
      "job_counts": {
        "waiting":   0,
        "active":    0,
        "completed": 5,
        "failed":    1,
        "delayed":   0
      }
    }
  }
}
```

**Response — HTTP `503` (one or more dependencies degraded)**:

```json
{
  "status": "degraded",
  "process": "api-server",
  "timestamp": "2026-05-13T20:35:00.000Z",
  "uptime": 360.2,
  "checks": {
    "postgres": { "status": "ok",    "latency_ms": 4 },
    "redis":    { "status": "error", "latency_ms": 12, "error": "Unexpected Redis ping response..." },
    "bullmq":   { "status": "error", "latency_ms": 2,  "error": "connect ECONNREFUSED..." }
  }
}
```

| Field | Type | Description |
|---|---|---|
| `status` | `"ok"` \| `"degraded"` | `"degraded"` if any check failed |
| `checks.{service}.status` | `"ok"` \| `"error"` | Per-service result |
| `checks.{service}.latency_ms` | number | Time in milliseconds for that check to complete |
| `checks.{service}.error` | string | Present only when `status` is `"error"`; contains the error message |
| `checks.bullmq.job_counts` | object | Present when BullMQ check succeeds; shows current queue depth |

**Production use**: Configure your load balancer's health check on this endpoint. A `503` response removes the node from rotation. Because `/ready` returns `503` for dependency issues (not just process issues), a flapping database connection will also remove the node from the load balancer — preventing the API from serving requests it cannot fulfil.

---

## `GET /metrics` — Admin Observability

**Purpose**: Provides a snapshot of the runtime state of the application for debugging, capacity planning, and active incident response.

**Authentication**: Requires a valid admin JWT. Returns `401` if no token is present, `403` if the token has a non-admin role.

**Response — HTTP `200`**:

```json
{
  "timestamp": "2026-05-13T20:31:00.000Z",
  "process": {
    "uptime_seconds": 120.5,
    "memory_mb": {
      "rss":        45.12,
      "heap_used":  18.40,
      "heap_total": 35.20
    },
    "node_version": "v20.x.x"
  },
  "queue": {
    "waiting":   0,
    "active":    0,
    "completed": 10,
    "failed":    2,
    "delayed":   0
  },
  "inventory": {
    "product_1": 45,
    "product_2": 10
  },
  "redis_memory_mb": 15.34
}
```

| Field | Source | Notes |
|---|---|---|
| `process.uptime_seconds` | `process.uptime()` | Seconds since the process started |
| `process.memory_mb.rss` | `process.memoryUsage().rss / 1024 / 1024` | Resident set size — total memory allocated to the process |
| `process.memory_mb.heap_used` | `process.memoryUsage().heapUsed / 1024 / 1024` | V8 heap in active use |
| `process.memory_mb.heap_total` | `process.memoryUsage().heapTotal / 1024 / 1024` | V8 heap capacity |
| `process.node_version` | `process.version` | Node.js runtime version |
| `queue.*` | `purchaseQueue.getJobCounts()` | Live BullMQ job counts across all states |
| `inventory` | `KEYS inventory:product-* → MGET` | Reads all inventory keys from Redis; key names map to product IDs |
| `redis_memory_mb` | `INFO memory → used_memory` | Parsed from the `used_memory` field in Redis `INFO memory` output |

### How Inventory Is Fetched

```js
const keys = await redisClient.keys("inventory:product-*");
const values = await redisClient.mget(...keys);
// map key → value into { product_1: 45, product_2: 10, ... }
```

`KEYS` scans all matching keys, then `MGET` fetches their values in a single round-trip.

### How Redis Memory Is Parsed

```js
const info = await redisClient.info("memory");
// info is a multi-line string: "used_memory:16093440\r\nused_memory_human:15.34M\r\n..."
const match = info.match(/used_memory:(\d+)/);
const bytes = parseInt(match[1]);
const mb = bytes / 1024 / 1024;
```

---

## Latency Interpretation Guide

| Scenario | `/health` | `/ready` | Interpretation |
|---|---|---|---|
| Local Docker Compose | < 1 ms | < 5 ms | Normal — all services on the same Docker network |
| Remote cloud databases | < 1 ms | 200–400 ms | Normal — network RTT to cloud service |
| `/ready` > 1 000 ms | < 1 ms | > 1 000 ms | Investigate database connection pool exhaustion or network degradation |
| `/health` slow | > 10 ms | — | Event loop may be blocked; investigate CPU-intensive synchronous code |
| `/ready` returns `503` | < 1 ms | 503 | A backing service (Postgres, Redis, or BullMQ) is unreachable |

**Rule of thumb**: If `/health` is fast but `/ready` is slow or failing, the problem is in a backing service — not the Node.js process itself. Do not restart the process; investigate the dependency.
