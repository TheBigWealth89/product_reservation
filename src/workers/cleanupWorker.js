import { pool, redisClient, connectAll } from "../db/connections.js";
import logger from "../utils/logger.js";
import purchaseQueue from "../queues/purchaseQueue.js";
import cron from "node-cron";
import { registerShutdownHandlers } from "../utils/shutdown.js";
import { cleanupProcessor } from "./processors/cleanup.processor.js";

// This function contains the core logic of your old worker
async function runCleanup() {
  logger.info("🔄 Cron job started: Checking for failed purchase jobs...");

  // Use a lock to prevent multiple instances from running at the same time
  const lockAcquired = await redisClient.set(
    "cleanup-lock",
    "running",
    "NX",
    "EX",
    300
  );

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
    for (const job of failedJobs) {
      await cleanupProcessor(job);
    }
  } catch (error) {
    logger.error("Error during cleanup process:", error);
  } finally {
    // Always release the lock
    await redisClient.del("cleanup-lock");
    logger.info("🔄 Cleanup job finished.");
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
