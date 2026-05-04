import "../config/loadEnv.js";
import Stripe from "stripe";
import logger from "../utils/logger.js";
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_placeholder", {
  apiVersion: "2025-08-27.basil",
});

export const verifyStripeWebhook = (req, res, next) => {
  const sig = req.headers["stripe-signature"];
  try {
    req.stripeEvent = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    next();
  } catch (err) {
    logger.error("Stripe verification failed:", err.message);
    res.status(400).send("Invalid Stripe signature");
  }
};
