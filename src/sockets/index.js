import { Server } from "socket.io";
import { redisClient } from "../db/connections.js";
import logger from "../utils/logger.js";

let io;
export const initSockets = (httpServer) => {
  io = new Server(httpServer);

  io.on("connection", (socket) => {
    logger.info(`A user connected with socket id:${socket.id}`);

    socket.on("join-product-room", (productId) => {
      socket.join(`product-${productId}`);
      logger.info(`Socket ${socket.id} joined room for product ${productId}`);
    });

    io.on("disconnect", (reason) => {
      logger.error(`User disconnected ${reason}`);
    });
  });
};

//Create thr redis subscriber
const subscriber = redisClient.duplicate();

// Subscribe to the CHANNEL, not the key
subscriber.subscribe("inventory-updates", (err, count) => {
  if (err) {
    logger.error("Failed to subscribe:", err);
    return;
  }
  logger.info(`Subscribed successfully to ${count} channels.`);
});

// Use the 'message' event listener to handle incoming messages
subscriber.on("message", (channel, message) => {
  logger.info(`Received message from channel: ${channel}`);
  if (channel === "inventory-updates") {
    const data = JSON.parse(message);
    // Broadcast the update ONLY to the specific product room
    io.to(`product-${data.productId}`).emit(
      "inventory-update",
      data.newInventory
    );
  }
});
