import express, { Router } from "express";
import { verifyStripeWebhook } from "../middleware/verifyWebhookSignature.js";
import logger from "../utils/logger.js";
import purchaseQueue from "../queues/purchaseQueue.js";
const router = Router();
router.post(
  "/webhook-stripe",
  express.raw({ type: "application/json" }),
  verifyStripeWebhook,
  async (req, res) => {
    console.log("Webhook triggered");
    const event = req.stripeEvent;
    const paymentIntent = event.data.object;
    const orderIds = paymentIntent.metadata.order_ids.split(",");

    if (event.type === "payment_intent.succeeded") {
      logger.info(`Payment succeeded ${paymentIntent.id}`);

      try {
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
      } catch (e) {
        logger.error(`Failed to queue job: ${e}`);
      }
    }

    res.json({ received: true });
  }
);

export default router;
