import { Queue, Worker } from "bullmq";
import { redisUrl } from "../service/redis.service.js";
import { redisClient, connectAll, pool } from "../connections.js";
import logger from "../utils/logger.js";
import purchaseQueue from "../queues/purchaseQueue.js";
import cron from "node-cron";

async function initialize() {
  await connectAll();

  // Initialize cleanup queue
  const cleanupQueue = new Queue("cleanup", {
    connection: { url: redisUrl },
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
      connection: { url: redisUrl },
      limiter: {
        max: 1,
        duration: 1000,
      },
    }
  );

  const testSchedule = "*/20 * * * * *"; // 6-part format for seconds
  logger.info(`Setting up test schedule: ${testSchedule}`);
  cron.schedule(testSchedule, () => {
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
