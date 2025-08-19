import { Queue, Worker } from "bullmq";
import { redisClient, connectAll, pool } from "../db/connections.js";
import logger from "../utils/logger.js";
import purchaseQueue from "../queues/purchaseQueue.js";
import cron from "node-cron";

async function initialize() {
  await connectAll();

  // Initialize cleanup queue
  const cleanupQueue = new Queue("cleanup", {
    connection: { redisClient },
  });

  // Create worker with verbose logging
  const cleanupWorker = new Worker(
    "cleanup",
    async () => {
      logger.info("🔄 Starting cleanup job...");

      const failedJobs = await purchaseQueue.getFailed();
      logger.info(`Found ${failedJobs.length} failed jobs to process`);

      for (const job of failedJobs) {
        const failedTime = job.failedOn
          ? new Date(job.failedOn)
          : job.timestamp
          ? new Date(job.timestamp)
          : null;

        const timeString = failedTime
          ? failedTime.toISOString()
          : "time not available";
        logger.info(`FailedOn ${timeString}`);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");

          // Process each item
          for (const cartItem of job.data?.successfulItems || []) {
            logger.info(`🛠️ Processing item: ${cartItem}`);

            // Before doing anything, check if this reservation has already been cancelled.
            const checkResult = await client.query(
              "SELECT status FROM reservations WHERE reservation_id = $1",
              [cartItem]
            );

            if (
              checkResult.rows.length > 0 &&
              checkResult.rows[0].status === "cancelled"
            ) {
              logger.warn(
                `Job ${job.id}: Reservation ${cartItem} already cancelled. Skipping.`
              );
              // Continue to the next item in the cart
              continue;
            }

            const [productId] = cartItem.split(":");

            //Update reservation
            const res = await client.query(
              `UPDATE reservations 
             SET status = 'cancelled',
                 updated_at = NOW()
             WHERE reservation_id = $1
             RETURNING id`,
              [cartItem]
            );
            logger.info(`📝 Updated ${res.rowCount} reservations`);

            // Restore inventory
            await redisClient.incr(`inventory:product-${productId}`);
            logger.info(`🔄 Restored inventory for product ${productId}`);
          }

          await client.query("COMMIT");
          await job.remove();
          logger.info(`✅ Successfully cleaned job ${job.id}`);
        } catch (err) {
          await client.query("ROLLBACK");
          logger.error(`❌ Failed to clean job ${job.id}:`, err);
        } finally {
          client.release();
        }
      }
    },
    {
      connection: { redisClient },
      limiter: {
        max: 1,
        duration: 1000,
      },
    }
  );

  // const testSchedule = "*/20 * * * * *";
  // const fiveMinutes = "*/5 * * * *";
  const threeHrs = "0 */3 * * *";
  logger.info(`Setting up test schedule: ${threeHrs}`);
  cron.schedule(threeHrs, () => {
    logger.info("⏰ Triggering scheduled cleanup");
    cleanupQueue.add("cleanup", {});
  });

  // Event listeners for monitoring
  cleanupWorker.on("completed", () => {
    logger.info("Cleanup job completed");
  });

  cleanupWorker.on("failed", (job, err) => {
    logger.error(`💥 Cleanup job failed: ${err.message}`);
  });

  logger.info("🚀 Cleanup worker started (20s test mode)");
}

initialize();
