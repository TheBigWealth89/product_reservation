# Docker Compose Configurations

The project ships three Docker Compose files for three distinct purposes. Never use the wrong file for your task — they connect to different databases and expose different ports.

---

## At a Glance

| File | Purpose | Databases | Env File | Command |
|---|---|---|---|---|
| `docker-compose.yml` | Cloud-connected, production-like | Render PostgreSQL + RedisLabs | `.env` | `docker compose up --watch` |
| `docker-compose.local.yml` | Fully local development | Local containers | `.env.local` | `docker compose -f docker-compose.local.yml up --watch` |
| `docker-compose.test.yml` | Isolated test environment | Local containers (tmpfs) | `.env.test` (via Vitest) | Managed automatically by `globalSetup.js` |

---

## `docker-compose.yml` — Cloud-Connected

**Purpose**: Runs the four application containers (API server + 3 workers) and connects them to your cloud-hosted PostgreSQL (e.g. Render) and Redis (e.g. RedisLabs) instances. Suitable for integration testing against real cloud infrastructure or for running the app locally while sharing cloud data.

**When to use it**: When you want to run the full application locally but connect to the production-equivalent cloud databases. Do not use this for day-to-day development — you risk overwriting cloud data.

**Services started**:

| Container | Image | Port |
|---|---|---|
| `prs-api-server` | `docker/api.Dockerfile` | `3000:3000` |
| `prs-fulfill-worker` | `docker/worker.Dockerfile` | None |
| `prs-expires-worker` | `docker/worker.Dockerfile` | None |
| `prs-cleanup-worker` | `docker/worker.Dockerfile` | None |

**Env file**: `.env` (cloud credentials — never commit this file).

**Command**:
```bash
docker compose up --watch
```

**Notes**:
- Does not start PostgreSQL or Redis containers — it expects `DB_HOST`, `DB_PORT`, and `REDIS_URL` in `.env` to point to cloud instances.
- `restart: always` on all services — containers restart automatically on crash.
- `stop_grace_period: 30s` on all services — see [Graceful Shutdown rationale](#why-stop_grace_period-30s).

---

## `docker-compose.local.yml` — Fully Local Development

**Purpose**: Spins up everything locally — dedicated PostgreSQL and Redis containers plus all four application containers. No cloud credentials needed. All data lives on your machine and is isolated from any production or staging environment.

**When to use it**: Day-to-day development. This is the recommended default.

**Services started**:

| Container | Image | Port Exposed to Host | Notes |
|---|---|---|---|
| `prs-local-postgres` | `postgres:15-alpine` | `5433:5432` | Volume-backed; schema auto-loaded from `./sql/init.sql` |
| `prs-local-redis` | `redis:7-alpine` | `6379:6379` | Volume-backed |
| `prs-local-api-server` | `docker/api.Dockerfile` | `3000:3000` | `--watch` mode; `./src` synced into container |
| `prs-local-fulfill-worker` | `docker/worker.Dockerfile` | None | `--watch` mode |
| `prs-local-expires-worker` | `docker/worker.Dockerfile` | None | `--watch` mode |
| `prs-local-cleanup-worker` | `docker/worker.Dockerfile` | None | `--watch` mode |

**Env file**: `.env.local`

**Commands**:
```bash
# Start with hot-reloading
docker compose -f docker-compose.local.yml up --watch

# Force rebuild (after Dockerfile or package.json changes)
docker compose -f docker-compose.local.yml up --build --watch

# Tear down and delete volumes (clean slate)
docker compose -f docker-compose.local.yml down -v
```

**Service dependency chain**:

Application containers will not start until their dependencies are healthy:

```
postgres  ─┐
            ├─ (condition: service_healthy) ─► api-server
redis     ─┘                                 ► fulfill-order-worker
                                              ► expires-worker
                                              ► cleanup-worker
```

Each service uses Docker's built-in `healthcheck` to signal readiness:
- PostgreSQL: `pg_isready -U prs_user -d prs_db` (every 5s, 10 retries)
- Redis: `redis-cli ping` (every 5s, 10 retries)

Application containers declare `depends_on` with `condition: service_healthy` so they never start before their backing services accept connections.

---

## `docker-compose.test.yml` — Isolated Test Environment

**Purpose**: Provides dedicated, ephemeral PostgreSQL and Redis containers strictly for the test suite. Managed automatically by Vitest's `globalSetup.js` — developers do not run this file directly.

**When to use it**: Never manually. It is started by `npm test`, `npm run test:integration`, and `npm run test:e2e` via `globalSetup.js`.

**Services started**:

| Container | Image | Port Exposed to Host | Notes |
|---|---|---|---|
| `postgres-test` | `postgres:15-alpine` | `5434:5432` | tmpfs storage — no data persistence |
| `redis-test` | `redis:7-alpine` | `6380:6379` | tmpfs storage — no data persistence |

**No API server or worker containers** — the test suite imports the Express app directly via `supertest` and calls processor functions directly, with no live processes required.

**Exact command used by `globalSetup.js`**:
```bash
# Start and wait for health checks to pass
docker compose -f docker-compose.test.yml up -d --wait

# Tear down and remove volumes after tests
docker compose -f docker-compose.test.yml down -v
```

---

## Why `tmpfs` in `docker-compose.test.yml`?

`tmpfs` mounts the database storage directory in RAM instead of on disk:

```yaml
tmpfs:
  - /var/lib/postgresql/data   # postgres-test
  - /data                      # redis-test
```

Two effects:
1. **Speed**: RAM I/O is orders of magnitude faster than disk. Database writes in tests are nearly instant.
2. **Guaranteed clean state**: When the container stops, `tmpfs` memory is released. No leftover data can leak between test runs. Running `docker compose -f docker-compose.test.yml down -v` after tests is therefore redundant for data isolation (but still needed to remove the container itself).

---

## Why `stop_grace_period: 30s` on All Services?

```yaml
stop_grace_period: 30s
```

When `docker compose stop` is run (or the stack is redeployed), Docker sends `SIGTERM` to the container's process. If the process has not exited after `stop_grace_period`, Docker sends `SIGKILL`.

This system implements a 20s → 25s → 30s timeout ladder:
- BullMQ worker drains its in-flight job with a **20-second** inner timeout.
- The overall graceful shutdown function has a **25-second** outer timeout.
- Docker's `stop_grace_period` is **30 seconds** — giving the process 5 seconds of headroom above the application-level timeout to exit cleanly before being force-killed.

Without this setting Docker defaults to 10 seconds, which is shorter than the BullMQ drain timeout. A long-running job would be `SIGKILL`ed mid-transaction, leaving an orphaned PostgreSQL row and an active BullMQ job that never resolves.

See [../operations/shutdown.md](../operations/shutdown.md) for the full graceful shutdown implementation.

---

## Docker Compose Watch — The `--watch` Flag

```bash
docker compose -f docker-compose.local.yml up --watch
```

Docker Compose Watch uses the `develop.watch` configuration in each service definition to sync file changes into running containers without rebuilding the image:

```yaml
develop:
  watch:
    - path: ./src
      target: /app/src
      action: sync       # rsync-like copy of changed files into container
    - path: ./package.json
      action: rebuild    # full image rebuild only when dependencies change
```

- **`action: sync`** on `./src` — any file saved under `./src/` on the host is immediately copied into `/app/src` inside the container. The Node.js `--watch` flag (in the container's `command`) detects the file change and restarts the process.
- **`action: rebuild`** on `package.json` — changing dependencies triggers a full `docker build`, ensuring `node_modules` inside the image is correct.

The result: edit a file in your editor, and the running container reflects the change within 1–2 seconds without a manual restart.
