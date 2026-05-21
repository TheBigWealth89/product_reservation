import { Worker } from "bullmq";
import { redisClient, pool } from "../db/connections.js";
import logger from "../utils/logger.js";
import { registerShutdownHandlers } from "../utils/shutdown.js";
import { fulfillOrderProcessor } from "./processors/fulfillOrder.processor.js";

const worker = new Worker(
  "fulfill-order",
  async (job) => {
    await fulfillOrderProcessor(job);
  },
  { connection: redisClient }
);

worker.on("failed", (job, err) => {
  logger.info(`Processing job ${job.id} attempt ${job.attemptsMade + 1}`);
});

registerShutdownHandlers({
  name: "Fulfill Order Worker",
  worker,
  dbPool: pool,
  redisClient,
});
