# Local Development Setup

This guide gets the project running from scratch on a developer machine. Docker is the recommended path — it handles all service dependencies automatically.

---

## Prerequisites

| Tool | Minimum Version | Notes |
|---|---|---|
| Node.js | v20+ | Required for native ESM and `--watch` flag support |
| npm | v10+ | Bundled with Node.js v20 |
| Docker Desktop | Any current release | Required for the recommended local setup |
| Git | Any | For cloning the repository |
| Stripe account | — | Free developer account; only test API keys are needed |

---

## Step-by-Step Local Setup (Recommended — Docker)

### 1. Clone the repository

```bash
git clone https://github.com/TheBigWealth89/product_reservation.git
cd product_reservation
```

### 2. Install Node.js dependencies

```bash
npm install
```

### 3. Create your environment file

```bash
cp .example.env .env.local
```

Open `.env.local` and fill in every value. For a fully local stack (no cloud services), use the values that match `docker-compose.local.yml`:

```bash
DB_HOST=127.0.0.1
DB_PORT=5433
DB_USER=prs_user
DB_PASSWORD=prs_pass
DB_NAME=prs_db
DB_SSL=false
REDIS_URL=redis://127.0.0.1:6379
JWT_SECRET=any-long-random-string
ADMIN_USERNAME=admin
ADMIN_PASS=adminpass
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

See [Environment Variables](#environment-variables) below for descriptions of every variable.

### 4. Start the full local stack

```bash
docker compose -f docker-compose.local.yml up --watch
```

This starts: PostgreSQL, Redis, the API server, and all three workers. The `--watch` flag enables live file sync — changes to `src/` are reflected inside the containers without a rebuild.

The API is available at `http://localhost:3000`.

---

## Manual Setup (Without Docker)

If you prefer to run Node.js processes directly on your machine with external PostgreSQL and Redis:

### 1. Start PostgreSQL and Redis

Use any running instances, or start them locally. Set connection details in `.env`.

### 2. Initialise the database schema

```bash
psql -h localhost -U your_user -d your_db -f sql/init.sql
```

### 3. Create `.env` with your values

```bash
cp .example.env .env
# Edit .env with your connection details
```

### 4. Start each process in a separate terminal

```bash
# Terminal 1 — API server
npm run dev

# Terminal 2 — Fulfill order worker
npm run dev:fulfillOrderWorker

# Terminal 3 — Expiration worker
npm run dev:expiresWorker

# Terminal 4 — Cleanup worker
npm run dev:cleanupWorker
```

---

## Environment Variables

| Variable | Required | Description | Example Value |
|---|---|---|---|
| `DB_HOST` | ✅ | PostgreSQL hostname | `127.0.0.1` |
| `DB_USER` | ✅ | PostgreSQL username | `prs_user` |
| `DB_PASSWORD` | ✅ | PostgreSQL password | `prs_pass` |
| `DB_NAME` | ✅ | PostgreSQL database name | `prs_db` |
| `DB_PORT` | ✅ | PostgreSQL port | `5432` |
| `DB_SSL` | ✅ | Enable SSL (`true`/`false`) | `false` for local, `true` for cloud |
| `REDIS_URL` | ✅ | Redis connection URL | `redis://127.0.0.1:6379` or `rediss://...` for TLS |
| `JWT_SECRET` | ✅ | Secret key for signing JWTs | Any non-empty string ≥ 32 chars |
| `ADMIN_USERNAME` | ✅ | Admin dashboard login name | `admin` |
| `ADMIN_PASS` | ✅ | Admin dashboard password | `adminpass` |
| `STRIPE_PUBLISHABLE_KEY` | ✅ | Stripe public key (used in browser) | `pk_test_51...` |
| `STRIPE_SECRET_KEY` | ✅ | Stripe secret key (server-side only) | `sk_test_51...` |
| `STRIPE_WEBHOOK_SECRET` | ✅ | Stripe webhook signing secret | `whsec_...` |
| `SESSION_SECRET` | — | Legacy field in `.example.env`; not used | Can be left blank |

### How to get Stripe keys

1. Create a free account at [stripe.com](https://stripe.com).
2. In the Dashboard → **Developers** → **API keys**, copy the test publishable and secret keys.
3. For the webhook secret: install the [Stripe CLI](https://stripe.com/docs/stripe-cli), run `stripe listen --forward-to localhost:3000/webhook-stripe`, and copy the `whsec_...` signing secret it prints.

---

## NPM Scripts

| Script | Command | Purpose |
|---|---|---|
| `dev` | `cross-env NODE_ENV=development nodemon src/server.js` | API server with Nodemon hot reload |
| `dev:fulfillOrderWorker` | `cross-env NODE_ENV=development node src/workers/fulfillOrderWorker.js` | Fulfill worker (dev) |
| `dev:expiresWorker` | `cross-env NODE_ENV=development node src/workers/expiresWorker.js` | Expiration worker (dev) |
| `dev:cleanupWorker` | `cross-env NODE_ENV=development node src/workers/cleanupWorker.js` | Cleanup worker (dev) |
| `start` | `cross-env NODE_ENV=production node src/server.js` | API server (production) |
| `start:fulfillOrderWorker` | `cross-env NODE_ENV=production node src/workers/fulfillOrderWorker.js` | Fulfill worker (production) |
| `start:expiresWorker` | `cross-env NODE_ENV=production node src/workers/expiresWorker.js` | Expiration worker (production) |
| `start:cleanupWorker` | `cross-env NODE_ENV=production node src/workers/cleanupWorker.js` | Cleanup worker (production) |
| `test` | `cross-env NODE_ENV=test vitest run` | Run full test suite (auto-manages Docker) |
| `test:unit` | `cross-env NODE_ENV=test vitest run tests/unit` | Unit tests only (no Docker) |
| `test:integration` | `cross-env NODE_ENV=test vitest run tests/integration` | Integration tests (auto Docker) |
| `test:e2e` | `cross-env NODE_ENV=test vitest run tests/e2e` | E2E tests (auto Docker) |
| `test:coverage` | `cross-env NODE_ENV=test vitest run --coverage` | Full suite with v8 coverage report |
| `test:watch` | `cross-env NODE_ENV=test vitest` | Watch mode for TDD |

---

## Common Setup Errors

### Error: `EADDRINUSE: address already in use :::3000`

**Cause**: `src/server.js` contains both `httpServer.listen(3000)` and `app.listen(port)` — port 3000 is bound twice. This is a known bug in the current codebase.

**Fix**: In `src/server.js`, remove the `app.listen(port)` call and keep only `httpServer.listen(3000)`. The `httpServer` (created by `node:http`) is the correct listener because Socket.IO is attached to it.

---

### Error: `Error: connect ECONNREFUSED 127.0.0.1:5432` (tests)

**Cause**: The `.env.test` file uses `localhost` for `DB_HOST` instead of `127.0.0.1`. Node.js resolves `localhost` to the IPv6 address `::1` before IPv4. If Docker maps the container port only to `0.0.0.0` (IPv4), the connection goes to `::1:5432` which has nothing listening.

**Fix**: In `.env.test`, set `DB_HOST=127.0.0.1` (not `localhost`) and `REDIS_URL=redis://127.0.0.1:6380`.

---

### Error: `Error: Missing required environment variable`

**Cause**: The application was started without a `.env` file, or the file is missing one or more required variables.

**Fix**:
1. Confirm `.env` (or `.env.local`) exists in the project root.
2. Check that all variables listed in the [Environment Variables](#environment-variables) table are present and non-empty.
3. Confirm `src/config/loadEnv.js` is resolving the path to the project root correctly — it uses `import.meta.url` to find the file regardless of the working directory.

---

### Error: `getaddrinfo ENOTFOUND` for PostgreSQL or Redis host

**Cause**: When running the app outside Docker (manual setup), the `DB_HOST` or `REDIS_URL` points to a Docker network hostname (e.g. `postgres`, `redis`) that only exists inside the Docker bridge network.

**Fix**: Use `127.0.0.1` for all host values when running processes directly on your machine. The Docker compose files expose ports to the host: PostgreSQL on `5433`, Redis on `6379` (local) or `6380` (test).
