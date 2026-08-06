# WebSockets and Real-Time Layer

This document covers the Socket.IO event contract, the Redis Pub/Sub channel that drives it, and how the bridge between the two works.

For the overall data flow context see [../architecture/data-flow.md](../architecture/data-flow.md).

---

## Overview

The real-time layer has two sides:

1. **Socket.IO** — browser-to-server persistent connection. Clients join a room per product and receive push events.
2. **Redis Pub/Sub** — process-to-process messaging. Any process that changes inventory publishes to a channel; the API server's subscriber forwards messages into Socket.IO rooms.

This two-layer design means workers (which run as separate processes with no access to the Socket.IO server object) can still trigger real-time browser updates by publishing to Redis. 

---

## Socket.IO Events

### `join-product-room` — Client Emits

| Field | Value |
|---|---|
| Direction | Browser → Server |
| Emitter | Client JavaScript in `product.ejs` |
| Payload | `{ productId: string }` |
| Effect | Server calls `socket.join("product-" + productId)`. The client is now in a room that receives inventory updates for that product only. |

**When it fires**: Immediately after the Socket.IO connection is established (`socket.on("connect", ...)`).

**Server handler** (`src/sockets/index.js`):
```js
io.on("connection", (socket) => {
  socket.on("join-product-room", ({ productId }) => {
    socket.join(`product-${productId}`);
  });
});
```

---

### `inventory-update` — Server Emits

| Field | Value |
|---|---|
| Direction | Server → Browser (room broadcast) |
| Emitter | `src/sockets/index.js` Redis subscriber handler |
| Target | All sockets in room `product-{productId}` |
| Payload | `{ newInventory: number }` |
| Effect | Client updates the inventory count displayed on the product page without a page refresh. |

**Payload example**:
```json
{ "newInventory": 4 }
```

**Client handler** (`product.ejs` embedded script):
```js
const socket = io();

socket.on("connect", () => {
  socket.emit("join-product-room", { productId: "<%= product.id %>" });
});

socket.on("inventory-update", ({ newInventory }) => {
  document.getElementById("inventory").textContent = newInventory;
});
```

---

## Redis Pub/Sub Channel

### `inventory-updates`

| Field | Value |
|---|---|
| Channel name | `inventory-updates` |
| Message format | JSON string |
| Publishers | `inventory.service.js`, `routes/products.js` |
| Subscriber | `src/sockets/index.js` |
c
**Message format**:
```json
{ "productId": "1", "newInventory": 4 }
```

All values are strings (Redis stores all values as strings). `newInventory` must be parsed to a number before use.

**Who publishes**:

| Publisher | When |
|---|---|
| `inventory.service.js` → `returnStock()` | When a reservation expires (`expiresWorker`), a job is cancelled (`cleanupWorker`), or an admin cancels an order |
| `routes/products.js` | Immediately after a successful reservation (`POST /product/:id/reserve`) |

---

## The Redis → Socket.IO Bridge

`src/sockets/index.js` performs the bridge. Here is the full sequence:

1. At startup, `initSockets(httpServer)` is called from `server.js`. It creates the Socket.IO server and attaches it to the HTTP server.
2. A *separate* Redis client is created by calling `redisClient.duplicate()`. This duplicate is used exclusively for the subscriber role. A Redis client that has issued `SUBSCRIBE` cannot send other commands — it is in a dedicated subscription mode.
3. `subscriber.subscribe("inventory-updates")` puts the duplicate client in subscribe mode.
4. On every message received:

```js
subscriber.on("message", (channel, message) => {
  if (channel === "inventory-updates") {
    const { productId, newInventory } = JSON.parse(message);
    io.to(`product-${productId}`).emit("inventory-update", { newInventory });
  }
});
```

5. The `io.to(...).emit(...)` call broadcasts to every Socket.IO client currently in the `product-{productId}` room — which is every browser tab open on that product's page.

**Why `redisClient.duplicate()` and not a new `ioredis` instance?** Using `duplicate()` copies the connection configuration (URL, TLS settings, auth) without re-reading the environment. It also ensures both the main client and the subscriber share the same connection behaviour without duplicating configuration code.

---

## Client-Side Implementation (product.ejs)

The full client-side flow embedded in `product.ejs`:

```html
<!-- Load Socket.IO client from the server (auto-served by socket.io) -->
<script src="/socket.io/socket.io.js"></script>

<script>
  const socket = io();

  // Step 1: join the room for this product as soon as connected
  socket.on("connect", () => {
    socket.emit("join-product-room", { productId: "<%= product.id %>" });
  });

  // Step 2: update the displayed inventory count on every push event
  socket.on("inventory-update", ({ newInventory }) => {
    const el = document.getElementById("inventory");
    if (el) el.textContent = newInventory;
  });
</script>
```

The `<%= product.id %>` is an EJS template expression rendered server-side at page load time. The `#inventory` element is a `<span>` in the product detail template whose text content is replaced on every `inventory-update` event.

**Important**: The client does not poll. It receives a push exactly when inventory changes — not on a timer. This means the UI update latency equals the round-trip time of the Redis publish → Socket.IO emit path, which is typically under 5 milliseconds on a local network.
