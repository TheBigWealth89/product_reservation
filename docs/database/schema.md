# PostgreSQL Schema

Source file: `sql/init.sql`. Run this file to initialise or reset the database schema.

```bash
psql $DATABASE_URL -f sql/init.sql
```

---

## `products` Table

Stores the product catalogue. Each row represents one product available for purchase.

```sql
CREATE TABLE products (
  id          SERIAL          PRIMARY KEY,
  name        VARCHAR(255)    NOT NULL,
  description TEXT,
  price       NUMERIC(10, 2)  NOT NULL,
  inventory   INT             NOT NULL CHECK (inventory >= 0),
  created_at  TIMESTAMPTZ     DEFAULT CURRENT_TIMESTAMP
);
```

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `SERIAL` | PRIMARY KEY | Auto-incrementing integer |
| `name` | `VARCHAR(255)` | NOT NULL | Product display name |
| `description` | `TEXT` | — | Optional long-form description |
| `price` | `NUMERIC(10, 2)` | NOT NULL | Stored to 2 decimal places; used as Stripe PaymentIntent amount |
| `inventory` | `INT` | NOT NULL, CHECK ≥ 0 | PostgreSQL-level guard prevents negative stock; Redis counter is the live fast-path |
| `created_at` | `TIMESTAMPTZ` | DEFAULT CURRENT_TIMESTAMP | Timezone-aware creation timestamp |

### Notes on `price`

`price` is stored as `NUMERIC(10, 2)` — exact decimal arithmetic, not floating point. This avoids floating-point rounding errors when computing totals or converting to Stripe's integer cents format (`price * 100`).

### Notes on `inventory`

The `CHECK (inventory >= 0)` constraint is a last-resort database-level guard. The application never allows inventory to go below zero at the Redis layer (via Lua script) or at the PostgreSQL layer (the worker only decrements after a confirmed payment, inside a transaction). The constraint exists to make the impossible visibly impossible.

---

## `orders` Table

Stores every reservation and purchase attempt. Each row tracks one order through its full lifecycle.

```sql
CREATE TABLE orders (
  id                        SERIAL          PRIMARY KEY,
  reservation_id            VARCHAR(255)    UNIQUE NOT NULL,
  user_id                   VARCHAR(255)    NOT NULL,
  product_id                INTEGER         NOT NULL,
  status                    VARCHAR(50)     DEFAULT 'reserved',
  stripe_payment_intent_id  VARCHAR(255),
  amount                    NUMERIC(10, 2)  NOT NULL,
  created_at                TIMESTAMPTZ     DEFAULT NOW(),
  expires_at                TIMESTAMPTZ,
  updated_at                TIMESTAMP       DEFAULT NOW()
);
```

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `SERIAL` | PRIMARY KEY | Auto-incrementing integer |
| `reservation_id` | `VARCHAR(255)` | UNIQUE, NOT NULL | Format: `{productId}:rev-{uuid}`. Unique constraint prevents duplicate reservations for the same key |
| `user_id` | `VARCHAR(255)` | NOT NULL | Identifies the authenticated user; matched against Stripe webhook metadata |
| `product_id` | `INTEGER` | NOT NULL | References `products.id` (no FK constraint — decoupled for performance) |
| `status` | `VARCHAR(50)` | DEFAULT `'reserved'` | One of: `reserved`, `payment_pending`, `completed`, `expired`, `cancelled` |
| `stripe_payment_intent_id` | `VARCHAR(255)` | — | Set when a Stripe PaymentIntent is created; used to look up the order from a webhook |
| `amount` | `NUMERIC(10, 2)` | NOT NULL | Snapshot of the price at time of reservation; used as Stripe charge amount |
| `created_at` | `TIMESTAMPTZ` | DEFAULT NOW() | When the reservation was created |
| `expires_at` | `TIMESTAMPTZ` | — | 10 minutes after `created_at`; used by `expiresWorker` to find stale reservations |
| `updated_at` | `TIMESTAMP` | DEFAULT NOW() | Last status transition time; not auto-updated by the DB — application must set it on writes |

### Notes on `reservation_id`

The `UNIQUE` constraint on `reservation_id` enforces at the database level that two orders cannot share the same reservation key. Since reservation keys are UUID-based (`{productId}:rev-{uuid}`), collisions are not expected in practice, but the constraint provides a hard guarantee.

### Notes on `expires_at`

`expires_at` is set at reservation time to `NOW() + INTERVAL '10 minutes'`. The `expiresWorker` queries `WHERE expires_at < NOW() AND status = 'reserved'`. Only `reserved` orders are expired by this worker — orders in `payment_pending` are intentionally excluded to avoid cancelling an order that is actively being paid.

---

## Initialising the Schema

```bash
# Against a local PostgreSQL instance
psql -h localhost -U your_user -d your_db -f sql/init.sql

# Against a Docker Compose postgres container
docker exec -i prs-local-postgres psql -U prs_user -d prs_db < sql/init.sql

# Via DATABASE_URL environment variable
psql $DATABASE_URL -f sql/init.sql
```

For the order lifecycle state machine, see [state-machine.md](state-machine.md).
