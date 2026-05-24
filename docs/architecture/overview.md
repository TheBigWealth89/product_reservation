# Architecture Overview

This document explains how the Product Reservation System is designed, why it is structured as multiple independent processes, and what problem each architectural decision solves.

---

## The Four Problems This System Solves

| Problem | Why It Is Hard | Solution |
|---|---|---|
| **Race Conditions** | Two users can read inventory simultaneously, both see "1 left", both reserve — overselling occurs | Redis Lua scripts make the check-and-decrement an atomic, uninterruptible operation |
| **System Failures** | The server can crash between receiving a Stripe webhook and writing the fulfillment to the database — order is lost | BullMQ persists jobs in Redis; idempotent workers re-process safely after restart |
| **Abandoned Carts** | A user reserves stock then abandons the session — inventory is locked forever | A polling worker expires reservations after 10 minutes and returns stock to Redis |
| **Stale UIs** | User A reserves the last item; User B's page still shows "1 available" until they refresh | Redis Pub/Sub broadcasts every inventory change; Socket.IO pushes it to every connected browser |

---

## The 4-Process Model

The system runs as **four independent Node.js processes**. Each process handles a clearly bounded responsibility. They communicate only through shared Redis and PostgreSQL — never by direct function call or shared memory.

| Process | Script | Purpose |
|---|---|---|
| API Server | `npm run dev` | HTTP routes, Socket.IO real-time layer, webhook receiver, admin dashboard |
| fulfillOrderWorker | `npm run dev:fulfillOrderWorker` | Pulls jobs from BullMQ; permanently decrements PostgreSQL inventory after confirmed payment |
| expiresWorker | `npm run dev:expiresWorker` | Polls PostgreSQL every 30 seconds; expires `reserved` orders older than 10 minutes and returns stock to Redis |
| cleanupWorker | `npm run dev:cleanupWorker` | Cron every 10 seconds; cancels permanently failed BullMQ jobs and returns stock |

### Why separate processes instead of in-process tasks?

Running workers as separate processes means:
- A crash in a worker does not take down the HTTP server or vice versa.
- Each process can be scaled independently on different machines.
- `docker stop` on one container triggers graceful shutdown for only that process, not the entire application.
- Memory pressure from long-running DB transactions in workers does not affect API response latency.

See [development/workers.md](../development/workers.md) for internals of each worker.

---

## Directory Structure

```
product_reservation/
├── .env                          # Environment variables (gitignored)
├── .example.env                  # Template for .env
├── .gitignore                    # .env, node_modules, logs, clear.js
├── package.json                  # ESM project, scripts, dependencies
├── decrement_inventory.lua       # Atomic Redis inventory decrement
├── validate_cart.lua             # Atomic cart validation at checkout
├── load-test.yml                 # Artillery load test config
├── test_concurrency.sh           # Bash concurrency test script
├── vitest.config.js              # Vitest test runner configuration
├── docker-compose.yml            # Cloud-connected, production-like compose
├── docker-compose.local.yml      # Fully local dev environment
├── docker-compose.test.yml       # Isolated test environment
├── sql/
│   └── init.sql                  # PostgreSQL schema (products + orders)
├── docker/
│   ├── api.Dockerfile            # Dockerfile for API server
│   └── worker.Dockerfile         # Dockerfile for worker processes
└── src/
    ├── app.js                    # Express app config (no listen) — for testing
    ├── server.js                 # Application entry point (calls app.listen)
    ├── config/
    │   └── loadEnv.js            # dotenv loader (resolves project root)
    ├── db/
    │   ├── connections.js        # PostgreSQL Pool + Redis client exports
    │   └── sync-inventory.js     # Startup inventory sync (PG → Redis)
    ├── middleware/
    │   ├── authenticate.js       # JWT cookie authentication & role guard
    │   ├── rateLimiter.js        # Redis-backed express rate limiters
    │   └── verifyWebhookSignature.js  # Stripe webhook signature verify
    ├── routes/
    │   ├── products.js           # Product CRUD, reservation, checkout, payment
    │   ├── admin.js              # Admin dashboard, retry/cancel failed jobs
    │   ├── auth.route.js         # Unified login/logout & JWT issuing
    │   └── webhook.js            # Stripe webhook endpoint
    ├── service/
    │   └── inventory.service.js  # returnStock() — atomic Redis INCR + Pub/Sub
    ├── queues/
    │   └── purchaseQueue.js      # BullMQ "fulfill-order" queue definition
    ├── sockets/
    │   └── index.js              # Socket.IO init + Redis subscriber bridge
    ├── utils/
    │   ├── logger.js             # Winston logger (console + file transports)
    │   ├── redisKeys.js          # Centralized Redis key generators
    │   └── shutdown.js           # Shared graceful shutdown utility
    ├── workers/
    │   ├── fulfillOrderWorker.js # BullMQ worker — fulfills paid orders
    │   ├── expiresWorker.js      # Polling worker — expires stale reservations
    │   ├── cleanupWorker.js      # Cron worker — cancels permanently failed jobs
    │   └── processors/           # Extracted processor functions (for testability)
    │       ├── fulfillOrderProcessor.js
    │       ├── expiryProcessor.js
    │       └── cleanupProcessor.js
    ├── views/
    │   ├── product.ejs           # Product detail + real-time inventory
    │   ├── orderPage.ejs         # Checkout / Stripe card payment
    │   ├── dashboard.ejs         # Admin failed-jobs dashboard
    │   └── login.ejs             # Admin login form
    ├── public/
    │   └── style.css             # Base button/body styles
    └── assets/
        └── pc.png                # Product image asset
```

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | Node.js v20+ (ESM) | Native ES module support; `--watch` flag for dev restarts without Nodemon in containers |
| HTTP Server | Express.js v5 | Minimal, well-understood; v5 includes async error propagation without wrapper boilerplate |
| Database | PostgreSQL via `pg` Pool | ACID transactions for the permanent inventory decrement — correctness over speed |
| Cache / Broker | Redis via `ioredis` | Sub-millisecond atomic operations via Lua; doubles as BullMQ backend and Pub/Sub bus |
| Job Queue | BullMQ | Persistent, retry-aware queue on Redis; survives process crashes without losing jobs |
| Payments | Stripe Payment Intents | Stripe holds money server-side until explicitly captured; webhook confirms success async |
| Real-Time | Socket.IO + Redis Pub/Sub | Workers publish to Redis; the API server subscribes and fans out to browser rooms |
| Templating | EJS | Server-rendered HTML with minimal client JS; avoids a full SPA build step |
| Logging | Winston | Structured JSON to files; coloured human output in console; level-filtered transports |
| Scheduling | node-cron | Lightweight cron inside the cleanupWorker process; no external scheduler needed |
| Auth | JWT in HTTP-only cookies | Prevents XSS token theft; JWT payload carries user ID and role for RBAC |
| Dev tooling | Docker Compose Watch | File-syncs `./src` into containers on save; triggers rebuild only on `package.json` change |

---

## Architectural Decision Notes

### Why Redis for the inventory counter (not just PostgreSQL)?

A PostgreSQL `UPDATE products SET inventory = inventory - 1 WHERE id = $1 AND inventory > 0` inside a transaction with `FOR UPDATE` locking would work but at high concurrency it creates lock contention — every reservation attempt serialises on the same row. A Redis Lua script runs atomically inside Redis's single-threaded executor with no lock overhead and sub-millisecond latency. PostgreSQL inventory is only permanently decremented once, after payment is confirmed, by a single worker with a row-level lock.

### Why BullMQ instead of processing webhooks synchronously?

Stripe expects the webhook endpoint to respond with HTTP 200 within 30 seconds. If the database is slow or momentarily unavailable, a synchronous approach times out and Stripe retries — potentially processing the payment twice. BullMQ decouples acknowledgement (fast `200 OK` back to Stripe) from fulfillment (durable job in Redis queue). If the database is down, the job waits and retries with backoff. When the database recovers, the job processes exactly once.

### Why four separate processes instead of `setInterval` inside the API server?

See the rationale in the 4-Process Model section above. The short answer: crash isolation, independent scaling, and clean `SIGTERM` handling per process.

### Why `src/app.js` separate from `src/server.js`?

The test suite uses `supertest`, which wraps the Express app directly without opening a real port. If `app.listen()` were called at import time (as in a typical `server.js`), every test file import would bind port 3000 and trigger `EADDRINUSE`. Extracting the Express configuration into `app.js` lets the test runner import it safely; `server.js` is the only file that calls `app.listen()`.

For API routes see [api/endpoints.md](../api/endpoints.md). For worker internals see [development/workers.md](../development/workers.md).
