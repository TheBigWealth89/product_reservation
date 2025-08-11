import { createClient } from "redis";
import logger from "./utils/logger.js";
import { pool } from "./db/index.js";
const subscriber = createClient();
const mainClient = createClient();

(async () => {
  await subscriber.connect();
  await mainClient.connect();
  logger.info(
    "Cleanup worker connected to Redis and listening for expired keys."
  );
  // Subscribe to the keyspace channel for expired events
  await subscriber.subscribe("__keyevent@0__:expired", async (key) => {
    logger.info(`Expired key detected: ${key}`);
    // Check if it's a reservation key we care about
    if (key.startsWith("reservation:product")) {
      const parts = key.split(":");
      console.log(parts);
      if (parts.length === 5) {
        const productId = parts[2];
        const userIdPart = parts[3];
        const userId = userIdPart.replace("user-", "");``
        const reservationId = parts[4].replace("rev-", "");
        const inventoryKey = `inventory:product-${productId}`;
        const cartKey = `cart:user-${userId}`;
        const cartItem = `${productId}:rev-${reservationId}`;

        // Also delete the durable reservation from PostgreSQL
        await pool.query(
          "DELETE FROM reservations WHERE product_id = $1 AND user_id = $2",
          [productId, userId]
        );
        logger.info(
          `Reservation deleted for product ${productId} and user ${userId}`
        );
        // Return stock
        const newInventory = await mainClient.incr(inventoryKey);
        logger.info(`Stock returned for product ${productId}.`);
        logger.info(`New inventory ${newInventory}`);
        // Remove product from user's cart
        await mainClient.sRem(cartKey, cartItem);
        logger.info(`Product ${cartItem} removed from cart of user ${cartKey}`);
      }
    }
  });
})();
