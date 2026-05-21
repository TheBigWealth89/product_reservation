import { pool } from "../../db/connections.js";
import { returnStock } from "../../service/inventory.service.js";
import logger from "../../utils/logger.js";

/**
 * Core cleanup logic extracted from cleanupWorker.
 * Processes a single failed BullMQ job: cancels the order and returns stock.
 */
export async function cleanupProcessor(job) {
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

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
      // Use inventory service to return the stock
      await returnStock(order.product_id);
      logger.info(
        `Cancelled order ${orderId} and returned stock for product ${order.product_id}.`
      );
    }

    await client.query("COMMIT");

    // Remove the handled job from the failed list
    if (job.remove) {
      await job.remove();
    }
    logger.info(`✅ Successfully cleaned job ${job.id}`);
  } catch (err) {
    if (client) await client.query("ROLLBACK");
    logger.error(`❌ Failed to clean job ${job.id}:`, err);
  } finally {
    if (client) client.release();
  }
}
