import { redisClient, pool } from "../db/connections.js";
import { syncInventoryToRedis } from "../db/sync-inventory.js";
import logger from "../utils/logger.js";

export const returnStock = async (productId) => {
  const inventoryKey = `inventory:product-${productId}`;

  // Atomically increase the inventory in Redis
  const newInventory = await redisClient.incr(inventoryKey);

  //Prepare the update message
  const updateMessage = JSON.stringify({
    productId: productId,
    newInventory: newInventory,
  });

  // Publish the update to the central channel
  await redisClient.publish("inventory-updates", updateMessage);

  logger.info(
    `Returned stock for product ${productId}. New inventory: ${newInventory}. Update published.`
  );
  return newInventory;
};

/**
 * Updates a product's inventory in the database and immediately synchronizes Redis.
 * This should be used whenever inventory is changed manually by an admin.
 */
export const updateProductInventory = async (productId, newCount) => {
  try {
    // 1. Update PostgreSQL
    await pool.query("UPDATE products SET inventory = $1 WHERE id = $2", [
      newCount,
      productId,
    ]);

    // 2. Sync to Redis (recalculates available stock minus active reservations)
    await syncInventoryToRedis(productId);

    logger.info(`Admin updated product ${productId} inventory to ${newCount}`);
  } catch (err) {
    logger.error(`Failed to update product ${productId} inventory:`, err);
    throw err;
  }
};

export default {
  returnStock,
  updateProductInventory,
};

