import "../config/loadEnv.js";
import Stripe from "stripe";
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
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
    console.error("Stripe verification failed:", err.message);
    res.status(400).send("Invalid Stripe signature");
  }
};
