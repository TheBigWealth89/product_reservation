import { pool, redisClient, connectAll } from "../db/connections.js";
import returnStock from "../service/inventory.service.js";
import logger from "../utils/logger.js";
import purchaseQueue from "../queues/purchaseQueue.js";
import cron from "node-cron";
import { registerShutdownHandlers } from "../utils/shutdown.js";

// This function contains the core logic of your old worker
async function runCleanup() {
  logger.info("🔄 Cron job started: Checking for failed purchase jobs...");

  // Use a lock to prevent multiple instances from running at the same time
  // This is critical if you ever scale to more than one worker instance.
  const lockAcquired = await redisClient.set(
    "cleanup-lock",
    "running",
    "NX",
    "EX",
    300
  ); // Lock expires after 5 minutes to prevent it getting stuck

  if (!lockAcquired) {
    logger.warn("Cleanup job is already running. Skipping this run.");
    return;
  }

  try {
    const failedJobs = await purchaseQueue.getFailed();
    if (failedJobs.length === 0) {
      logger.info("✅ No failed jobs to clean up.");
      return;
    }

    logger.info(`Found ${failedJobs.length} failed jobs to process.`);
    // You can add your batch processing logic here if you want.
    // For simplicity, this version processes them one by one.
    for (const job of failedJobs) {
      await processFailedJob(job);
    }
  } catch (error) {
    logger.error("Error during cleanup process:", error);
  } finally {
    // Always release the lock
    await redisClient.del("cleanup-lock");
    logger.info("🔄 Cleanup job finished.");
  }
}

async function processFailedJob(job) {
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // The job data now has `orderId`
    const { orderId } = job.data;

    // Update the order status to 'cancelled'
    const updateResult = await client.query(
      `UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND status != 'completed'`,
      [orderId]
    );

    if (updateResult.rowCount > 0) {
      const order = (
        await client.query("SELECT product_id FROM orders WHERE id = $1", [
          orderId,
        ])
      ).rows[0];
      // Use your inventory service to return the stock
      await returnStock(order.product_id);
      logger.info(
        `Cancelled order ${orderId} and returned stock for product ${order.product_id}.`
      );
    }

    await client.query("COMMIT");
    await job.remove(); // Remove the handled job from the failed list
    logger.info(`✅ Successfully cleaned job ${job.id}`);
  } catch (err) {
    if (client) await client.query("ROLLBACK");
    logger.error(`❌ Failed to clean job ${job.id}:`, err);
  } finally {
    if (client) client.release();
  }
}

// Main initialization function
async function initialize() {
  await connectAll();

  const schedule = "*/10 * * * * *"; // Every 10 seconds for testing
  logger.info(`🚀 Cleanup scheduler started. Running every 10 seconds.`);

  const task = cron.schedule(schedule, runCleanup);

  registerShutdownHandlers({
    name: "Cleanup Worker",
    stopTimer: () => task.stop(),
    queue: purchaseQueue,
    dbPool: pool,
    redisClient,
  });
}

initialize();
