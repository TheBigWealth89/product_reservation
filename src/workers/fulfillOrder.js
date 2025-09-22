import { Worker } from "bullmq";
import { redisClient, pool } from "../db/connections.js";
import logger from "../utils/logger.js";

new Worker(
  "fulfill-order",
  async (job) => {
    if (!job.data || !job.data.orderId) {
      logger.error(
        `Job ${job.id} failed: Invalid job data received.`,
        job.data
      );
      // Throw an error to move the job to the failed queue without retrying.
      throw new Error("Invalid job data: missing orderId.");
    }

    const { orderId } = job.data;
    logger.info(`Fulfilling order ${orderId}`);

    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");

      // Get the order details
      const orderResult = await client.query(
        "SELECT * FROM orders WHERE id = $1 FOR UPDATE", // Lock the row
        [orderId]
      );
      const order = orderResult.rows[0];

      if (!order) {
        throw new Error(`Order with ID ${orderId} not found.`);
      }

      // Idempotency Check
      if (order.status === "completed") {
        logger.warn(`Order ${orderId} has already been fulfilled. Skipping.`);
        await client.query("COMMIT"); // Commit the empty transaction
        return; // Job is successful
      }

      // throw error("server crashed");

      //Decrement the main inventory in the products table
      await client.query(
        "UPDATE products SET inventory = inventory - 1 WHERE id = $1 AND inventory > 0",
        [order.product_id]
      );

      //Mark the order as 'completed'
      await client.query(
        "UPDATE orders SET status = 'completed' WHERE id = $1",
        [orderId]
      );

      await client.query("COMMIT");
      logger.info(`✅ Order ${orderId} fulfilled successfully.`);
    } catch (e) {
      if (client) {
        await client.query("ROLLBACK");
      }

      logger.error(`Job ${job.id} failed: ${e.message}`, {
        stack: e.stack,
        data: job.data,
      });
      logger.info(`Processing job ${job.id} attempt ${job.attemptsMade + 1}`);
      throw e; // Re-throw to trigger BullMQ's retry
    } finally {
      if (client) {
        client.release();
      }
    }
  },
  { connection: redisClient }
);
