import { redisClient, pool } from "./connections.js";
import logger from "../utils/logger.js";

export const syncInventoryToRedis = async (targetProductId = null) => {
  try {
    // Determine which products to sync
    let query = "SELECT id, inventory FROM products";
    let params = [];
    if (targetProductId) {
      query += " WHERE id = $1";
      params = [targetProductId];
    }

    const result = await pool.query(query, params);
    const products = result.rows;

    if (products.length === 0 && targetProductId) {
      logger.warn(`Sync requested for non-existent product ID: ${targetProductId}`);
      return;
    }

    //Sync each product's inventory to redis
    const multi = redisClient.multi();
    for (const product of products) {
      const totalInventory = product.inventory;

      // Count only reserved + unexpired reservations
      const reservationResult = await pool.query(
        `SELECT COUNT(*) 
         FROM orders 
         WHERE product_id = $1 
           AND status = 'reserved'`,
        [product.id]
      );

      const pendingPayment = await pool.query(
        `SELECT COUNT(*) 
         FROM orders 
         WHERE product_id = $1 AND
        status = 'payment_pending'`,
        [product.id]
      );

      const activePendingPayment = parseInt(pendingPayment.rows[0].count, 10);
      const activeReservations = parseInt(reservationResult.rows[0].count, 10);

      // Calculate the true available inventory
      const availableInventory = Math.max(
        0,
        totalInventory - activeReservations - activePendingPayment
      );

      // Set this correct value in Redis
      const key = `inventory:product-${product.id}`;
      multi.set(key, availableInventory);

      // Prepare the update message for real-time UI
      const updateMessage = JSON.stringify({
        productId: product.id,
        newInventory: availableInventory,
      });
      multi.publish("inventory-updates", updateMessage);

      logger.info(
        `Synced ${key} with available inventory ${availableInventory}`
      );
    }
    await multi.exec();
  } catch (err) {
    logger.error("Failed to sync inventory to Redis:", err);
    throw err;
  }
};
