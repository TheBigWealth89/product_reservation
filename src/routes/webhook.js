import express, { Router } from "express";
import { verifyStripeWebhook } from "../middleware/verifyWebhookSignature.js";
import logger from "../utils/logger.js";
import purchaseQueue from "../queues/purchaseQueue.js";
import { pool, redisClient } from "../db/connections.js";
import { redisKey } from "../utils/redisKeys.js";
const router = Router();

router.post(
  "/webhook-stripe",
  express.raw({ type: "application/json" }),
  verifyStripeWebhook,
  async (req, res) => {
    const event = req.stripeEvent;
    const paymentIntent = event.data.object;
    const orderIds = paymentIntent.metadata.order_ids.split(",");

    if (event.type === "payment_intent.succeeded") {
      logger.info(`Payment succeeded ${paymentIntent.id}`);

      try {
        // throw new Error("TESTING_RETRY: Intentional Webhook Failure");

        for (const orderId of orderIds) {
          await purchaseQueue.add(
            "fulfill-order",
            {
              orderId: orderId,
            },
            {
              attempts: 3,
              backoff: {
                type: "fixed",
                delay: 1000,
              },
              removeOnComplete: true,
              removeOnFail: false,
            }
          );
        }
        logger.info(
          `Queued fulfillment jobs for orders: ${orderIds.join(", ")}`
        );

        const result = await pool.query(
          "SELECT id, reservation_id, product_id, user_id FROM orders WHERE id = ANY($1::int[])",
          [orderIds]
        );

        const userIdFromMetadata = paymentIntent.metadata.user_id;

        // Security check: Ensure metadata user_id matches database records
        const mismatch = result.rows.find(row => row.user_id !== userIdFromMetadata);
        if (mismatch) {
          logger.error(`CRITICAL: User ID mismatch in webhook! Stripe: ${userIdFromMetadata}, DB: ${mismatch.user_id} for order ${mismatch.id}`);
          return res.json({ received: true, warning: "user_mismatch" });
        }

        const userId = userIdFromMetadata;
        if (result.rows.length > 0) {
          const multi = redisClient.multi();
          const cartKey = redisKey.cartKey(userId);

          for (const row of result.rows) {
            const { reservation_id, product_id } = row;
            const uuid = reservation_id.split("rev-")[1];
            const reservationKey = redisKey.reservationKey(
              product_id,
              userId,
              uuid
            );
            multi.del(reservationKey);
            multi.srem(cartKey, reservation_id);
          }

          await multi.exec();
          logger.info("✅ Redis state successfully cleaned up after purchase.");
        }
      } catch (e) {
        logger.error(`Failed to process webhook for payment ${paymentIntent.id}: ${e}`);
        return res.status(500).json({ error: "Webhook processing failed. Retry requested." });
      }
    }

    res.json({ received: true });
  }
);

export default router;
