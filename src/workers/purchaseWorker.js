import { Worker } from "bullmq";
import { redisUrl, pool } from "../service/redis.service.js";
import logger from "../utils/logger.js";

new Worker(
  "purchase-processing",
  async (job) => {
    let client;
    try {
      const { successfulItems, userId } = job.data;
      logger.info(`Processing purchase job ${job.id} for user ${userId}`);

      client = await pool.connect();
      await client.query("BEGIN");

      for (const cartItem of successfulItems) {
        const [productId] = cartItem.split(":");

        // Before doing anything, check if this reservation has already been completed.
        const checkResult = await client.query(
          "SELECT status FROM reservations WHERE reservation_id = $1",
          [cartItem]
        );

        if (
          checkResult.rows.length > 0 &&
          checkResult.rows[0].status === "completed"
        ) {
          logger.warn(
            `Job ${job.id}: Reservation ${cartItem} already completed. Skipping.`
          );
          // Continue to the next item in the cart
          continue;
        }

        // Reduce inventory in Postgres
        const result = await client.query(
          "UPDATE products SET inventory = inventory - 1 WHERE id = $1 AND inventory > 0 RETURNING id",
          [productId]
        );

        if (result.rowCount === 0) {
          throw new Error(`Product ${productId} out of stock`);
        }

        throw new Error("Server crashed");

        if (result.rowCount > 0) {
          await client.query(
            `UPDATE reservations
                  SET status = 'completed',
                      updated_at = NOW(),
                      completed_at = NOW()
                  WHERE reservation_id = $1`,
            [cartItem]
          );
        }
      }
      await client.query("COMMIT");
      logger.info(`Job ${job.id} completed successfully.`);
    } catch (e) {
      if (client) {
        await client.query("ROLLBACK");
      }
      logger.error(`Job ${job.id} failed: ${e.message}`, {
        stack: e.stack,
        data: job.data,
      });
      // logger.error(`Job ${job.id} failed. It will be retried.`, e);
      logger.info(`Processing job ${job.id} attempt ${job.attemptsMade + 1}`);
      throw e;
    } finally {
      client.release();
    }
  },
  { connection: { url: redisUrl } }
);

logger.info("Database worker started and listening for jobs.");
