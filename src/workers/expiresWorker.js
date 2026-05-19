import { pool, redisClient } from "../db/connections.js";
import { returnStock } from "../service/inventory.service.js";
import logger from "../utils/logger.js";
import { registerShutdownHandlers } from "../utils/shutdown.js";

class ExpirationCleanup {
  constructor() {
    this.isRunning = false;
    this.interval = 30000; // 30 seconds
    this.timer = null;
    this._runningPromise = Promise.resolve(); // tracks the active cleanupExpired call
  }

  async cleanupExpired() {
    if (this.isRunning) return;
    this.isRunning = true;
    // Expose the promise so stop() can await any in-flight run
    this._runningPromise = this._doCleanup();
    await this._runningPromise;
  }

  async _doCleanup() {
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

          // Remove from cart
          await redisClient.srem(
            `cart:user-${reservation.user_id}`,
            reservation.reservation_id
          );

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
      this.isRunning = false;
    }
  }

  start() {
    logger.info("Starting expiration cleanup worker (30s interval)");
    this.timer = setInterval(() => this.cleanupExpired(), this.interval);
    this.cleanupExpired(); // Run immediately
  }

  async stop() {
    clearInterval(this.timer); // stop future poll cycles
    await this._runningPromise; // wait for any in-flight run to finish
    logger.info("[Expires Worker] In-flight cleanup awaited");
  }
}

// Start the cleanup
const cleanup = new ExpirationCleanup();
cleanup.start();

registerShutdownHandlers({
  name: "Expires Worker",
  stopTimer: () => cleanup.stop(), // async — awaited inside shutdown helper
  dbPool: pool,
  redisClient,
});

export default cleanup;
