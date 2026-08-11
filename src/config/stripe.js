import "./loadEnv.js";
import Stripe from "stripe";

/**
 * Single shared Stripe SDK instance.
 * Import this wherever Stripe is needed — never call `new Stripe()` elsewhere.
 * Having one instance ensures consistent config (API version, timeout) across
 * payment intent creation and webhook signature verification.
 */
const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY || "sk_test_placeholder",
  {
    apiVersion: "2025-08-27.basil",
  }
);

export default stripe;
