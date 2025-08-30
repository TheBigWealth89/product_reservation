import { pool, redisClient } from "../db/connections.js";
import returnStock from "../service/inventory.service.js"
import logger from "../utils/logger.js";

class ExpirationCleanup {
  constructor() {
    this.isRunning = false;
    this.interval = 30000; // 30 seconds
  }
  async cleanupExpired() {
    if (this.isRunning) return;
    this.isRunning = true;

    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      // Find expired reservations
      const expired = await client.query(`
        SELECT * FROM reservations 
        WHERE expires_at < NOW() 
        AND status = 'pending'
        FOR UPDATE SKIP LOCKED
      `);
      for (const reservation of expired.rows) {
        try {
          // Update status
          await client.query(
            `UPDATE reservations SET status = 'expired' WHERE id = $1`,
            [reservation.id]
          );

          // Restore inventory
          // await redisClient.incr(`inventory:product-${reservation.product_id}`);
          await returnStock(reservation.product_id)

          // Remove from cart
          await redisClient.srem(
            `cart:user-${reservation.user_id}`, 
            reservation.reservation_id
          );

          logger.info(`Cleaned expired reservation: ${reservation.reservation_id}`);
        } catch (err) {
          logger.error(`Failed to clean reservation ${reservation.id}:`, err);
          // Continue with other reservations
        }
      }

      await client.query('COMMIT');
      
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Cleanup transaction failed:', err);
    } finally {
      client.release();
      this.isRunning = false;
    }
  }

  start() {
    logger.info('🔄 Starting expiration cleanup worker (30s interval)');
    setInterval(() => this.cleanupExpired(), this.interval);
    this.cleanupExpired(); // Run immediately
  }
}

// Start the cleanup
const cleanup = new ExpirationCleanup();
cleanup.start();

export default cleanup;