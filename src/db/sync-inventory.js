import { pool } from "./index.js";
import redisService from "../service/redis.service.js";
import logger from "../utils/logger.js";

export const syncInventoryToRedis = async () => {
  try {
    //Fetch all products from postgreSQL
    const result = await pool.query("SELECT id, inventory FROM products");
    const products = result.rows;

    logger.info("products:", products);

    //Sync each product's inventory to redis
    for (const product of products) {
      const key = `inventory:product-${product.id}`;
      await redisService.client.set(key, product.inventory);
      logger.info(`Synced ${key} with inventory ${product.inventory}`);
    }
  } catch (err) {
    logger.error("Failed to sync inventory to Redis:", err);
  }
};
