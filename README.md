# Product Reservation System

A production-grade, fault-tolerant e-commerce reservation and payment system built with Node.js, PostgreSQL, Redis, and BullMQ. It solves the four hardest problems in high-concurrency commerce: race conditions on shared inventory, lost orders during system failures, abandoned cart stock leakage, and stale user interfaces showing wrong inventory counts — all in a single, deployable multi-process Node.js application.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (v20+, ESM modules) |
| HTTP Server | Express.js v5 |
| Database | PostgreSQL (via `pg` Pool) |
| Cache / Queue Broker | Redis (via `ioredis`) |
| Job Queue | BullMQ |
| Payments | Stripe (Payment Intents + Webhooks) |
| Real-Time | Socket.IO + Redis Pub/Sub |
| Templating | EJS |
| Logging | Winston (file + console transports) |
| Scheduling | node-cron |
| Authentication | JWT in HTTP-only cookies |
| Development | Docker Compose Watch + Node.js `--watch` |

---

## Architecture Diagram

```mermaid
graph TD
    U["User Browser"] -->|HTTP / WebSocket| API["API Server :3000"]
    API -->|Lua scripts / Pub-Sub / Queue| R["Redis"]
    API -->|SQL queries| PG["PostgreSQL"]
    API -->|Payment Intents| ST["Stripe API"]
    ST -->|Webhooks| API
    R -->|BullMQ jobs| W1["fulfillOrderWorker"]
    R -->|Pub/Sub| API
    W1 -->|SQL transactions| PG
    W2["expiresWorker"] -->|Polls every 30s| PG
    W2 -->|INCR + Pub/Sub| R
    W3["cleanupWorker"] -->|Cron every 10s| PG
    W3 -->|INCR + Pub/Sub| R
```

---

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/TheBigWealth89/product_reservation.git
cd product_reservation

# 2. Copy the environment template and fill in your values
cp .example.env .env

# 3. Start the fully local stack (PostgreSQL + Redis + all services)
docker compose -f docker-compose.local.yml up --watch
```

The API is available at `http://localhost:3000`. See [docs/development/setup.md](docs/development/setup.md) for manual setup and all environment variable descriptions.

---

## Documentation Index

| File | Description |
|---|---|
| [docs/architecture/overview.md](docs/architecture/overview.md) | System design, 4-process model, directory structure, tech stack rationale |
| [docs/architecture/data-flow.md](docs/architecture/data-flow.md) | Payment flow, reservation flow, Redis Pub/Sub bridge, webhook flow |
| [docs/architecture/fault-tolerance.md](docs/architecture/fault-tolerance.md) | Every defensive pattern — what it protects, where it lives, why it was chosen |
| [docs/api/endpoints.md](docs/api/endpoints.md) | Complete API reference: all routes, auth, rate limits, request/response shapes |
| [docs/api/websockets.md](docs/api/websockets.md) | Socket.IO events, Redis Pub/Sub channel, real-time bridge explained |
| [docs/database/schema.md](docs/database/schema.md) | PostgreSQL tables: all columns, types, constraints |
| [docs/database/redis.md](docs/database/redis.md) | Redis key schema, TTLs, Lua scripts, Pub/Sub channel |
| [docs/database/state-machine.md](docs/database/state-machine.md) | Order status lifecycle: valid transitions, invalid transitions, inventory impact |
| [docs/development/setup.md](docs/development/setup.md) | Prerequisites, local setup steps, env vars, npm scripts, common errors |
| [docs/development/docker.md](docs/development/docker.md) | All three Compose files explained — when to use each, what each starts |
| [docs/development/workers.md](docs/development/workers.md) | Worker architecture, each worker explained, processor extraction |
| [docs/operations/health.md](docs/operations/health.md) | `/health`, `/ready`, `/metrics` endpoints — shapes, latency, interpretation |
| [docs/operations/logging.md](docs/operations/logging.md) | Winston config, log levels, transports, log file locations |
| [docs/operations/shutdown.md](docs/operations/shutdown.md) | Graceful shutdown — full implementation detail, timeout ladder, per-process sequences |
| [docs/testing/strategy.md](docs/testing/strategy.md) | Testing philosophy, Vitest rationale, layers, infrastructure, test isolation |
| [docs/testing/test-cases.md](docs/testing/test-cases.md) | All critical paths A–I with every test case in structured format |
| [docs/testing/running-tests.md](docs/testing/running-tests.md) | How to run tests, all npm test scripts, priority ranking, CI integration |

---

## Known Limitations

> **Mock User Database**: `src/routes/auth.route.js` uses a hardcoded `MOCK_USERS` object for authentication. In production this must be replaced with a real database user table and a proper credential-hashing flow (e.g. bcrypt + a `users` table in PostgreSQL).

> **Unused `pool` package**: The `pool` package (`^0.4.1`) appears in the dependency tree but serves no purpose — `pg` ships its own `Pool` class that is already in use throughout the codebase. The `pool` package can be safely removed with `npm uninstall pool`.
