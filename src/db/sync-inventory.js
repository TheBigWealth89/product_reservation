import { pool } from "./index.js";
import redisService from "../service/redis.service.js";
import logger from "../utils/logger.js";

export const syncInventoryToRedis = async () => {
  try {
    //Fetch all products from postgreSQL
    const result = await pool.query("SELECT id, inventory FROM products");
    const products = result.rows;

    //Sync each product's inventory to redis
    for (const product of products) {
      // 1. Get the total inventory
      const totalInventory = product.inventory;

      // 2. Get the count of active reservations for this product
      const reservationResult = await pool.query(
        "SELECT COUNT(*) FROM reservations WHERE product_id = $1 AND expires_at > NOW()",
        [product.id]
      );
      const activeReservations = parseInt(reservationResult.rows[0].count, 10);

      // 3. Calculate the true available inventory
      const availableInventory = totalInventory - activeReservations;

      // 4. Set this correct value in Redis
      const key = `inventory:product-${product.id}`;
      await redisService.client.set(key, availableInventory);
      logger.info(
        `Synced ${key} with available inventory ${availableInventory}`
      );
    }
  } catch (err) {
    logger.error("Failed to sync inventory to Redis:", err);
  }
};
