# Health and Metrics Probes

This application exposes three observability endpoints to monitor the health and performance of the API Server.

## 1. Liveness Probe (`GET /health`)
- **Purpose**: Fast check to verify if the Node.js process is alive and responsive. Used by Docker or Kubernetes to determine if the container needs to be restarted.
- **Dependencies**: None. This endpoint purposely avoids checking any external systems (Postgres/Redis) to prevent restarting the app when dependencies are temporarily down.
- **Authentication**: Public

**Response** (HTTP 200 always, < 5ms):
```json
{
  "status": "ok",
  "process": "api-server",
  "timestamp": "2026-05-13T20:31:00.000Z",
  "uptime": 120.5
}
```

## 2. Readiness Probe (`GET /ready`)
- **Purpose**: Checks if the app is fully ready to handle traffic. Used by load balancers to route requests away from unhealthy nodes.
- **Dependencies Checked**: PostgreSQL, Redis, and BullMQ (checked in parallel).
- **Authentication**: Public

**Response on Success** (HTTP 200):
```json
{
  "status": "ok",
  "process": "api-server",
  "timestamp": "2026-05-13T20:31:00.000Z",
  "uptime": 120.5,
  "checks": {
    "postgres": { "status": "ok", "latency_ms": 4 },
    "redis": { "status": "ok", "latency_ms": 1 },
    "bullmq": { "status": "ok", "latency_ms": 2, "job_counts": { "waiting": 0, "active": 0, "completed": 5, "failed": 1, "delayed": 0 } }
  }
}
```

**Response on Failure** (HTTP 503):
```json
{
  "status": "degraded",
  "process": "api-server",
  "timestamp": "2026-05-13T20:35:00.000Z",
  "uptime": 360.2,
  "checks": {
    "postgres": { "status": "ok", "latency_ms": 4 },
    "redis": { "status": "error", "latency_ms": 12, "error": "Unexpected Redis ping response..." },
    "bullmq": { "status": "error", "latency_ms": 2, "error": "connect ECONNREFUSED..." }
  }
}
```

## 3. Metrics & Observability (`GET /metrics`)
- **Purpose**: Provides deep insights into the runtime state of the application. Useful for debugging issues or active incident response.
- **Authentication**: Requires Admin JWT Authentication (HTTP 401/403 otherwise).

**Response**:
```json
{
  "timestamp": "2026-05-13T20:31:00.000Z",
  "process": {
    "uptime_seconds": 120.5,
    "memory_mb": {
      "rss": 45.12,
      "heap_used": 18.40,
      "heap_total": 35.20
    },
    "node_version": "v20.x.x"
  },
  "queue": {
    "waiting": 0,
    "active": 0,
    "completed": 10,
    "failed": 2,
    "delayed": 0
  },
  "inventory": {
    "product_1": 45,
    "product_2": 10
  },
  "redis_memory_mb": 15.34
}
```
