import { createClient } from "redis";
import logger from "../utils/logger.js";
import { pool } from "../db/connections.js";
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
        const userId = userIdPart.replace("user-", "");
        const reservationId = parts[4].replace("rev-", "");
        console.log("reservation id:", reservationId);
        const inventoryKey = `inventory:product-${productId}`;
        const cartKey = `cart:user-${userId}`;
        const cartItem = `${productId}:rev-${reservationId}`;

        try {
          // Update DB status
          const result = await pool.query(
            `UPDATE reservations 
            SET status = 'expired', updated_at = NOW() 
            WHERE product_id = $1 AND user_id = $2 AND   reservation_id = $3 AND status = 'pending'`,
            [productId, userId, cartItem]
          );

          if (result.rowCount > 0) {
            logger.info(
              `Reservation ${reservationId} marked as expired for product ${productId}, user ${userId}`
            );

            // Return stock to Redis
            const newInventory = await mainClient.incr(inventoryKey);
            logger.info(
              `Stock returned for product ${productId}, new inventory: ${newInventory}`
            );

            logger.info(`New inventory ${newInventory}`);

            // Remove from user's cart
            await mainClient.sRem(cartKey, cartItem);
            logger.info(
              `Product ${cartItem} removed from cart of user ${userId}`
            );
          } else {
            logger.info(
              `Reservation ${reservationId} was already completed or not found`
            );
          }
        } catch (err) {
          logger.error(`Error processing expired reservation: ${err.message}`);
        }
      }
    }
  });
})();
