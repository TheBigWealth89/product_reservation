import { redisClient, pool } from "./connections.js";
import logger from "../utils/logger.js";

/**
 * Synchronizes available product inventory from PostgreSQL to Redis.
 * 
 * OPTIMIZATION (N+1 Query Fix):
 * Previously, this function executed 1 query to fetch products, followed by 2 queries per product
 * inside a loop to count 'reserved' and 'payment_pending' orders (1 + 2N queries total).
 * 
 * Now, a single aggregated LEFT JOIN query with FILTER (WHERE ...) is used to fetch products
 * along with their active reservation counts in ONE database round-trip (O(1) queries),
 * preventing database performance bottlenecks during startup or bulk sync operations.
 *
 * @param {number|null} targetProductId - Optional product ID to sync a single product. If null, syncs all products.
 */
export const syncInventoryToRedis = async (targetProductId = null) => {
  try {
    // Single aggregated query using LEFT JOIN and PostgreSQL FILTER conditional aggregates
    // to calculate active reservations ('reserved' and 'payment_pending') in one DB round-trip.
    let query = `
      SELECT 
        p.id, 
        p.inventory,
        COUNT(o.id) FILTER (WHERE o.status = 'reserved') AS active_reservations,
        COUNT(o.id) FILTER (WHERE o.status = 'payment_pending') AS active_pending_payment
      FROM products p
      LEFT JOIN orders o ON p.id = o.product_id AND o.status IN ('reserved', 'payment_pending')
    `;
    let params = [];

    if (targetProductId) {
      query += " WHERE p.id = $1";
      params = [targetProductId];
    }

    query += " GROUP BY p.id, p.inventory";

    const result = await pool.query(query, params);
    const products = result.rows;

    if (products.length === 0 && targetProductId) {
      logger.warn(`Sync requested for non-existent product ID: ${targetProductId}`);
      return;
    }

    // Batch update Redis state using a multi pipeline
    const multi = redisClient.multi();
    for (const product of products) {
      const totalInventory = parseInt(product.inventory, 10);
      const activeReservations = parseInt(product.active_reservations, 10) || 0;
      const activePendingPayment = parseInt(product.active_pending_payment, 10) || 0;

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

