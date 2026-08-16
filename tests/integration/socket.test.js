/**
 * Integration tests for Socket.IO real-time inventory broadcast:
 * Tests initSockets, room joining ("join-product-room"), and forwarding
 * Redis Pub/Sub "inventory-updates" messages to socket clients in product rooms.
 */
import { describe, test, expect, beforeEach, afterAll } from "vitest";
import { createServer } from "http";
import { initSockets } from "../../src/sockets/index.js";
import { getRedis, closeConnections } from "../setup/testHelpers.js";

const redis = getRedis();

describe("Socket.IO Real-Time Inventory Broadcast", () => {
  let httpServer;
  let io;

  beforeEach(() => {
    httpServer = createServer();
    io = initSockets(httpServer);
  });

  afterAll(async () => {
    if (io) {
      io.close();
    }
    await closeConnections();
  });

  test("subscribes to Redis Pub/Sub and emits inventory-update to room on message", async () => {
    const productId = 42;
    const newInventory = 7;
    const roomName = `product-${productId}`;

    // Mock a client socket joining the room
    let emittedEvent = null;
    let emittedPayload = null;

    const mockSocket = {
      id: "mock-socket-101",
      join: (room) => {
        expect(room).toBe(roomName);
      },
      on: (event, handler) => {
        if (event === "join-product-room") {
          handler(productId);
        }
      },
    };

    // Spy on io.to().emit()
    const originalTo = io.to;
    io.to = (room) => {
      if (room === roomName) {
        return {
          emit: (event, payload) => {
            emittedEvent = event;
            emittedPayload = payload;
          },
        };
      }
      return originalTo.call(io, room);
    };

    // Simulate socket connection event
    io.emit("connection", mockSocket);

    // Publish update message to Redis Pub/Sub channel
    const updateMessage = JSON.stringify({
      productId: productId,
      newInventory: newInventory,
    });
    await redis.publish("inventory-updates", updateMessage);

    // Wait briefly for Redis subscriber message callback
    await new Promise((r) => setTimeout(r, 150));

    expect(emittedEvent).toBe("inventory-update");
    expect(emittedPayload).toBe(newInventory);
  });
});