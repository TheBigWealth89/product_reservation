# Data Flow

This document traces how data moves through the system for the three primary flows: the full payment lifecycle, the Redis Pub/Sub real-time update bridge, and the Stripe webhook-to-fulfillment path.

For static schema definitions see [../database/schema.md](../database/schema.md) and [../database/redis.md](../database/redis.md).

---

## Payment Flow (End-to-End Sequence)

```mermaid
sequenceDiagram
    participant U as User
    participant API as API Server
    participant R as Redis
    participant PG as PostgreSQL
    participant S as Stripe
    participant W as fulfillOrderWorker

    U->>API: POST /product/:id/reserve
    API->>R: EVAL decrement_inventory.lua
    R-->>API: newInventory (or -1 if out of stock)
    API->>PG: INSERT INTO orders (status='reserved')
    API->>R: SETEX reservation key (TTL 600s)
    API->>R: SADD cart entry
    API->>R: PUBLISH inventory-updates
    API-->>U: { reservationKey, expiredAt }

    U->>API: POST /product/create-payment-intent
    API->>R: EVAL validate_cart.lua
    API->>PG: UPDATE orders SET status='payment_pending'
    API->>S: stripe.paymentIntents.create()
    S-->>API: { clientSecret }
    API-->>U: { clientSecret }

    U->>S: stripe.confirmCardPayment()
    S->>API: POST /webhook-stripe (payment_intent.succeeded)
    Note over API: 1. Verify User ID in Metadata vs DB
    Note over API: 2. If mismatch, return 200 + warning (abort)
    Note over API: 3. If error, return 500 (trigger Stripe retry)
    API->>R: purchaseQueue.add("fulfill-order")
    API->>R: DEL reservation keys, SREM cart

    W->>R: Pull job from queue
    W->>PG: BEGIN; SELECT FOR UPDATE; UPDATE products; UPDATE orders status='completed'; COMMIT
```

---

## Reservation Flow (Step-by-Step Narrative)

### Phase 1 — Reserve

1. The user visits `GET /product/:id`. The API reads `inventory:product-{id}` from Redis and renders the page with a live count.
2. The user clicks **Reserve**. The browser sends `POST /product/:id/reserve` with a JWT cookie.
3. The API runs `EVAL decrement_inventory.lua` in Redis. The Lua script atomically reads the counter, checks it is greater than zero, decrements it, and returns the new value. If the counter is already zero, it returns `-1` and the request fails with `409 Out of Stock`.
4. On success the API:
   - Inserts a new row into `orders` with `status = 'reserved'` and an `expires_at` timestamp 10 minutes in the future.
   - Writes `SETEX reservation:product:{id}:user-{userId}:rev-{uuid} 600` — a TTL key in Redis that proves the reservation is still live.
   - Adds the cart entry to `SADD cart:user-{userId}`.
   - Publishes `{ productId, newInventory }` to the `inventory-updates` Redis channel so all connected browsers update immediately.
5. The API responds with `{ reservationKey, expiredAt }`.

### Phase 2 — Checkout

6. The user views their cart at `GET /product`. The API renders the order page with cart contents.
7. The user clicks **Pay**. The browser sends `POST /product/create-payment-intent`.
8. The API runs `EVAL validate_cart.lua`. The script iterates every item in the cart set, checks whether the reservation TTL key still exists in Redis, and splits items into `validItems` and `expiredItems`. Expired items cannot proceed.
9. For valid items the API updates `orders.status` to `'payment_pending'`.
10. The API calls `stripe.paymentIntents.create()` with the order total and embeds `user_id` and `order_id` in the `metadata` field.
11. Stripe returns a `clientSecret`. The API sends it to the browser.

### Phase 3 — Payment Confirmation

12. The browser calls `stripe.confirmCardPayment(clientSecret)` using Stripe.js.
13. Stripe processes the card. On success it POSTs `payment_intent.succeeded` to `POST /webhook-stripe`.
14. The API verifies the webhook signature using `STRIPE_WEBHOOK_SECRET`. Invalid signatures return `400`.
15. The API compares `event.data.object.metadata.user_id` with the `user_id` from the database order row. A mismatch (possible replay attack or data corruption) aborts with a `200` (so Stripe stops retrying) plus a warning log.
16. The API adds a `fulfill-order` job to BullMQ, then deletes all reservation and cart keys for this order from Redis.

### Phase 4 — Fulfillment

17. `fulfillOrderWorker` pulls the job from the BullMQ queue.
18. It opens a PostgreSQL transaction with `SELECT ... FOR UPDATE` to lock the order row.
19. **Idempotency check**: if `status === 'completed'` the worker exits early without touching inventory — the job was a duplicate.
20. It decrements `products.inventory` by 1 (permanent, in PostgreSQL).
21. It sets `orders.status = 'completed'`.
22. It commits the transaction.

---

## Redis Pub/Sub Flow

The real-time inventory update path is a one-way bridge from any process that changes inventory to every browser watching any product page.

```
Publisher                    Redis                     Subscriber (API Server)
────────────────────         ──────────────────        ──────────────────────────────────
inventory.service.js         channel:                  sockets/index.js
  returnStock(productId)  →  inventory-updates      →  redis.on('message', handler)
                             message:                    ↓
products.js (reserve)     →  { productId,              JSON.parse(message)
                               newInventory }            ↓
expiresWorker              →                          io.to(`product-${productId}`)
cleanupWorker              →                            .emit('inventory-update', { newInventory })
                                                        ↓
                                                     Every browser in that Socket.IO room
                                                     updates its #inventory display element
```

**Channel**: `inventory-updates`

**Message format**:
```json
{ "productId": "1", "newInventory": 4 }
```

**Publishers**: `inventory.service.js` (called by `expiresWorker`, `cleanupWorker`, and `admin.js` cancel), and `products.js` (directly after a successful reservation).

**Subscriber**: `sockets/index.js` creates a *duplicate* of the shared Redis client specifically for the subscriber role (a Redis client in subscribe mode cannot issue other commands). On every message it parses the JSON and emits the `inventory-update` Socket.IO event to the `product-{id}` room.

See [../api/websockets.md](../api/websockets.md) for the client-side Socket.IO event details.

---

## Webhook Flow (Stripe → Fulfillment)

```
Stripe                API Server                    Redis / PostgreSQL
──────                ──────────                    ─────────────────────────────────
payment               POST /webhook-stripe
_intent               verifyWebhookSignature        
.succeeded   ──────►  middleware validates           
                      signature                     
                      ↓                             
                      webhook.js handler:           
                      1. Query PG for order         orders: SELECT WHERE
                         by stripe PI id    ──────► payment_intent_id = $1
                      2. Validate metadata          
                         user_id match              
                      3. purchaseQueue.add() ──────► Redis: LPUSH BullMQ queue
                      4. DEL reservation    ──────► Redis: DEL + SREM
                         + cart keys                
                      5. Return HTTP 200            
                      ↓                             
fulfillOrderWorker:                                 
  BRPOP queue   ◄─────────────────────────────────  Redis: job dequeued
  BEGIN                                            
  SELECT FOR    ──────────────────────────────────► PG: row lock
  UPDATE                                           
  UPDATE        ──────────────────────────────────► PG: products.inventory - 1
  products                                         
  UPDATE orders ──────────────────────────────────► PG: status = 'completed'
  COMMIT                                           
```

**Why return HTTP 500 on unexpected errors in the webhook?** Stripe interprets any non-2xx response as a failure and will automatically retry the webhook with exponential backoff for up to 3 days. Returning `500` on a genuine processing error delegates retry responsibility to Stripe rather than requiring a manual intervention.

**Why return HTTP 200 on a metadata mismatch?** A mismatch means the order was already processed or the event is stale. Retrying it would not help — Stripe would keep sending it. Returning `200` tells Stripe the event was acknowledged and it stops retrying, while the warning log alerts the operator.
