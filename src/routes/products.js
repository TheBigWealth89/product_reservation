import "../config/loadEnv.js";
import { redisKey } from "../utils/redisKeys.js";
import express from "express";
import Stripe from "stripe";
import { redisClient, pool } from "../db/connections.js";
import logger from "../utils/logger.js";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { reserveLimiter, paymentLimiter } from '../middleware/rateLimiter.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_placeholder", {
  apiVersion: "2025-08-27.basil",
});

// Load the Lua script text when the module loads
const reserveLuaScript = fs.readFileSync(
  path.join(__dirname, "../../decrement_inventory.lua"),
  "utf8"
);
const checkoutLuaScript = fs.readFileSync(
  path.join(__dirname, "../../validate_cart.lua"),
  "utf8"
);

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM products WHERE id = $1", [
      id,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).send("Product not found");
    }

    const product = result.rows[0];
    // Get inventory from Redis for consistency in UI
    const inventory = await redisClient.get(`inventory:product-${id}`);

    if (inventory !== null) {
      product.inventory = parseInt(inventory, 10);
    }

    //No store catch
    res.setHeader("Cache-Control", "no-store");

    res.render("product", { product });
  } catch (err) {
    logger.error(`Error to get reservations ${err}`);
    res.status(500).send("Server error");
  }
});

router.post("/:id/reserve", reserveLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM products WHERE id = $1", [
      id,
    ]);

    // User ID from authentication middleware
    const userId = req.user.id;
    const inventoryKey = redisKey.inventoryKey(id);
    const cartKey = redisKey.cartKey(userId);

    // Run atomic Lua script to decrement inventory
    const newInventory = await redisClient.eval(
      reserveLuaScript,
      1,
      inventoryKey
    );

    logger.info(`Lua returned inventory ${newInventory}`);
    if (newInventory < 0) {
      return res.status(400).json({ error: "Out of stock" });
    }

    const updateMessage = JSON.stringify({
      productId: id,
      newInventory: newInventory,
    });

    await redisClient.publish("inventory-updates", updateMessage);

    // Generate clean reservation ID
    const reservationId = uuidv4();
    const cartEntry = redisKey.cartEntry(id, reservationId);
    const reservationKey = redisKey.reservationKey(id, userId, reservationId);
    const productAmount = result.rows[0].price;
    const tenMinutesFromNow = new Date(Date.now() + 600000); // 10 minutes (600,000ms)

    //Save to DB
    await pool.query(
      "INSERT INTO orders (product_id, user_id, expires_at, reservation_id, amount) VALUES ($1, $2, $3, $4, $5)",
      [id, userId, tenMinutesFromNow, cartEntry, productAmount]
    );

    // Set Redis reservation key with TTL (10 minutes)
    await redisClient.setex(reservationKey, 600, "reserved");

    await redisClient.sadd(cartKey, cartEntry);
    logger.info(
      `Product ${id} reserved for user ${userId}. Hold expires in 10 minutes.`
    );

    logger.info(
      `Reservation successfully for product ${id}. New inventory: ${newInventory}`
    );

    res.json({
      message: "Reservation successfully",
      inventory: newInventory,
      reservationKey: reservationKey,
      // reservationId: reservationId,
      // expiredAt: tenMinutesFromNow,
    });
  } catch (err) {
    logger.error("Error in reservation:", err);
    res.status(500).json({ error: "server error" });
  }
});

router.get("/", async (req, res) => {
  try {
    const userId = req.user.id;
    const cartKey = redisKey.cartKey(userId);

    //Get all item IDs from the user's cart in Redis
    const cartItems = await redisClient.smembers(cartKey);
    // redisClient.del(cartKey)
    // redisClient.srem(cartKey)

    if (cartItems.length === 0) {
      return res.render("orderPage", {
        cartItems: [],
        totalAmountForDisplay: "0.00",
        totalAmountInCents: 0,
        stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      });
    }

    // Count quantities for each product
    const productQuantities = {};
    cartItems.forEach((item) => {
      const productId = item.split(":")[0];
      productQuantities[productId] = (productQuantities[productId] || 0) + 1;
    });

    // Get unique product IDs for database query
    const uniqueProductIds = Object.keys(productQuantities).map((id) =>
      parseInt(id)
    );
    const priceResult = await pool.query(
      "SELECT id, name, price FROM products WHERE id = ANY($1::int[])",
      [uniqueProductIds]
    );

    // Calculate the total amount with quantities
    let totalAmountInCents = 0;
    const productsInCart = priceResult.rows.map((product) => {
      const quantity = productQuantities[product.id];
      const priceInDollars = parseFloat(product.price);
      const priceInCents = Math.round(priceInDollars * 100);
      const totalPriceForProduct = priceInCents * quantity;

      totalAmountInCents += totalPriceForProduct;

      // Return product with quantity info for display
      return {
        ...product,
        quantity,
        priceInCents,
        totalPrice: totalPriceForProduct,
      };
    });

    // Format for display (e.g., 2550 -> "25.50")
    const totalAmountForDisplay = (totalAmountInCents / 100).toFixed(2);

    res.render("orderPage", {
      cartItems: productsInCart,
      totalAmountForDisplay,
      totalAmountInCents,
      stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });
  } catch (err) {
    logger.error("Failed to render checkout page:", err);
    res.status(500).send("Error loading checkout page.");
  }
});

router.post("/create-payment-intent", paymentLimiter, async (req, res) => {
  logger.info("Creating payment intent...");
  const userId = req.user.id;
  const cartKey = redisKey.cartKey(userId);
  let client = null;
  let successfulItems = [];
  let compensationClient = null; // Separate client for compensation

  try {
    console.log("User ID from token:", userId);

    console.log("Carrt Key: ", cartKey);

    console.log("Checkout Lua script:", checkoutLuaScript)
    //Validate the cart in Redis
    logger.info("Starting cart validation.... ")
    const [validatedItems, failedItems] = await redisClient.eval(
      checkoutLuaScript,
      1,
      cartKey,
      userId
    );

    logger.info("Cart validation completed")
    logger.info(`Validated items: ${JSON.stringify(validatedItems)}`);
    logger.info(`Failed items: ${JSON.stringify(failedItems)}`);

    successfulItems = validatedItems;

    if (successfulItems.length === 0) {
      return res.status(400).json({
        message: "Checkout failed. No valid reservations found.",
        successful_Items: [],
        expired_or_invalid: failedItems,
      });
    }

    //Start the database transaction
    client = await pool.connect();
    await client.query("BEGIN");

    //Batch update all orders at once
    const reservationIds = successfulItems.map((item) => item);

    const orderResult = await client.query(
      `UPDATE orders 
       SET status = 'payment_pending', updated_at = NOW()
       WHERE reservation_id = ANY($1) AND status = 'reserved'
       RETURNING id, amount, reservation_id`,
      [reservationIds]
    );

    if (orderResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "No valid orders found for payment processing",
      });
    }

    // Calculate total amount
    const totalAmount = orderResult.rows.reduce((sum, row) => {
      return sum + parseFloat(row.amount) * 100;
    }, 0);

    const createOrderIds = orderResult.rows.map((row) => row.id);

    await client.query("COMMIT");

    // Create the Stripe Payment Intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(totalAmount), // Ensure it's an integer
      currency: "usd",
      metadata: {
        order_ids: createOrderIds.join(","),
        user_id: userId
      },
    });

    logger.info(`Client secret ${paymentIntent.client_secret}`);
    res.send({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    logger.error("Error during payment intent creation:", err);

    // Rollback the main transaction
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        logger.error("Failed to rollback main transaction:", rollbackErr);
      }
    }

    // Compensation logic with separate connection
    if (successfulItems.length > 0) {
      logger.warn("Initiating compensation back to reserved state...");

      try {
        compensationClient = await pool.connect();
        await compensationClient.query("BEGIN");

        // Batch revert all orders
        const reservationIds = successfulItems.map((item) => item);
        await compensationClient.query(
          `UPDATE orders 
           SET status = 'reserved', updated_at = NOW()
           WHERE reservation_id = ANY($1) AND status = 'payment_pending'`,
          [reservationIds]
        );

        await compensationClient.query("COMMIT");

        logger.info(
          "✅ Compensation successful. Orders are back in a reserved state."
        );
      } catch (compensationError) {
        if (compensationClient) {
          try {
            await compensationClient.query("ROLLBACK");
          } catch (rollbackErr) {
            logger.error(
              "Failed to rollback compensation transaction:",
              rollbackErr
            );
          }
        }
        logger.error(
          "!!! CRITICAL: COMPENSATION FAILED !!! Manual intervention required.",
          compensationError
        );
      }
    }

    res.status(500).json({ error: "Failed to process payment." });
  } finally {
    // Clean up connections
    if (client) {
      client.release();
    }
    if (compensationClient) {
      compensationClient.release();
    }
  }
});
export default router;
