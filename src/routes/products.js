import express from "express";
import { pool } from "../db/index.js";
import logger from "../utils/logger.js";
import redisService from "../service/redis.service.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

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
    const inventory = await redisService.client.get(`inventory:product-${id}`);
    product.inventory = parseInt(inventory, 10) || product.inventory;
    res.render("product", { product });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

// Load the Lua script text when the module loads
const luaScript = fs.readFileSync(
  path.join(__dirname, "../../decrement_inventory.lua"),
  "utf8"
);

router.post("/:id/reserve", async (req, res) => {
  try {
    const { id } = req.params;

    // Assuming this would come from authentication section
    const userId = req.headers["x-user-id"] || "user-123";
    const key = `inventory:product-${id}`;
    const cartKey = `cart:user-${userId}`;

    const newInventory = await redisService.client.eval(luaScript, {
      keys: [key],
    });

    if (newInventory < 0) {
      return res.status(400).json({ error: "Out of stock" });
    }

    // This create a temporary reservation key for this user with a 10-minute TTL (600 seconds)
    // SETEX is atomic, so the key is created and its expiration is set in one command.
    const reservationId = Date.now();
    const reservationKey = `reservation:product:${id}:user-${userId}:rev-${reservationId}`;
    console.log("First key:", reservationKey);
    await redisService.client.setEx(reservationKey, 5, "reserved");

    // Add productId to user's cart in Redis Set
    const cartEntry = `${id}:rev-${reservationId}`;
    await redisService.client.sAdd(cartKey, cartEntry);
    logger.info(
      `Product ${id} reserved for user ${userId}. Hold expires in 10 minutes.`
    );

    logger.info(
      `Reservation successfully for product ${id}. New inventory: ${newInventory}a`
    );

    res.json({
      message: "Reservation successfully",
      inventory: newInventory,
      reservationKey: reservationKey,
      // reservationId: reservationId,
    });
  } catch (err) {
    logger.error("Error in reservation:", err);
    res.status(500).json({ error: "server error" });
  }
});

router.post("/:id/purchase", async (req, res) => {
  try {
    const userId = req.headers["x-user-id"] || "user-123";
    const cartKey = `cart:user-${userId}`;

    // Get all items in user's cart
    let cartItems = await redisService.client.sMembers(cartKey);
    logger.info(`Full cart items ${cartItems}`)

    if (cartItems.length === 0) {
      return res.status(400).json({ error: "Your cart is empty." });
    }

    // Failsafe Cleanup: Remove expired reservations from cart
    for (const cartItem of cartItems) {
      const [productId, reservationId] = cartItem.split(":rev-");
      const reservationKey = `reservation:product:${productId}:user-${userId}:rev-${reservationId}`;

      const reservationExists = await redisService.client.exists(
        reservationKey
      );

      if (reservationExists === 0) {
        console.log(`Removing expired reservation from cart: ${cartItem}`);
        await redisService.client.sRem(cartKey, cartItem);
      }
    }

    // Refresh cart after cleanup
    cartItems = await redisService.client.sMembers(cartKey);

    if (cartItems.length === 0) {
      return res
        .status(400)
        .json({ error: "No active reservations found. Please reserve again." });
    }

    let failedPurchases = [];
    let successfulPurchases = [];

    // Process Valid Reservations
    for (const cartItem of cartItems) {
      const [productId, reservationId] = cartItem.split(":rev-");
      const reservationKey = `reservation:product:${productId}:user-${userId}:rev-${reservationId}`;

      const reservationExists = await redisService.client.exists(
        reservationKey
      );

      if (reservationExists === 0) {
        // Should not happen after cleanup but just in case
        failedPurchases.push(cartItem);
        continue;
      }

      // Proceed with DB Update (Source of Truth)
      await pool.query(
        "UPDATE products SET inventory = inventory - 1 WHERE id = $1",
        [productId]
      );

      // Remove reservation and cart entry
      await redisService.client.del(reservationKey);
      await redisService.client.sRem(cartKey, cartItem);

      successfulPurchases.push(cartItem);
    }

    res.json({
      message: "Checkout complete.",
      successful: successfulPurchases,
      failed: failedPurchases,
    });
  } catch (err) {
    logger.error("Error in purchase:", err);
    res.status(500).json({ error: "server error" });
  }
});

export default router;
