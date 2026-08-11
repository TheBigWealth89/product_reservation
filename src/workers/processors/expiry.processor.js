import { pool, redisClient } from "../../db/connections.js";
import { returnStock } from "../../service/inventory.service.js";
import { redisKey } from "../../utils/redisKeys.js";
import logger from "../../utils/logger.js";

/**
 * Core expiry cleanup logic extracted from expiresWorker.
 * Finds expired 'reserved' orders and marks them expired,
 * restores stock, and removes cart entries.
 */

export async function expiryProcessor() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    // Find expired reservations
    const expired = await client.query(`
      SELECT * FROM orders 
      WHERE expires_at < NOW() 
      AND status = 'reserved'
      FOR UPDATE SKIP LOCKED
    `);
    for (const reservation of expired.rows) {
      try {
        // Update status
        await client.query(
          `UPDATE orders SET status = 'expired' WHERE id = $1`,
          [reservation.id]
        );

        // Restore inventory
        await returnStock(reservation.product_id);

        // Parse the uuid from "productId:rev-uuid" stored as reservation_id in DB
        const uuid = reservation.reservation_id.split("rev-")[1];
        const reservationKeyToDelete = redisKey.reservationKey(
          reservation.product_id,
          reservation.user_id,
          uuid
        );

        // Remove from cart
        await redisClient.srem(
          redisKey.cartKey(reservation.user_id),
          reservation.reservation_id
        );

        // Explicitly delete the TTL reservation key so validate_cart.lua
        // cannot treat this as a valid reservation even before its TTL fires.
        await redisClient.del(reservationKeyToDelete);

        logger.info(
          `Cleaned expired reservation: ${reservation.reservation_id}`
        );
      } catch (err) {
        logger.error(`Failed to clean reservation ${reservation.id}:`, err);
        // Continue with other reservations
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error("Cleanup transaction failed:", err);
  } finally {
    client.release();
  }
}
