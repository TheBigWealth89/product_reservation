import express from "express";
import { pool } from "../db/index.js";
import logger from "../utils/logger.js";
import redisService from "../service/redis.service.js";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

// Load the Lua script text when the module loads
const reserveLuaScript = fs.readFileSync(
  path.join(__dirname, "../../decrement_inventory.lua"),
  "utf8"
);
const checkoutLuaScript = fs.readFileSync(
  path.join(__dirname, "../../checkout.lua"),
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
    const inventory = await redisService.client.get(`inventory:product-${id}`);
    product.inventory = parseInt(inventory, 10) || product.inventory;
    res.render("product", { product });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

router.post("/:id/reserve", async (req, res) => {
  try {
    const { id } = req.params;
    // Assuming this would come from authentication section
    const userId = req.headers["x-user-id"] || "user-123";
    const key = `inventory:product-${id}`;
    const cartKey = `cart:user-${userId}`;

    const newInventory = await redisService.client.eval(reserveLuaScript, {
      keys: [key],
    });

    if (newInventory < 0) {
      return res.status(400).json({ error: "Out of stock" });
    }

    const reservationId = uuidv4();
    const cartEntry = `${id}:rev-${reservationId}`;

    const tenMinutesFromNow = new Date(Date.now() + 10000);
    await pool.query(
      "INSERT INTO reservations (product_id, user_id, expires_at, reservation_id) VALUES ($1, $2, $3, $4)",
      [id, userId, tenMinutesFromNow, cartEntry]
    );

    // This create a temporary reservation key for this user with a 10-minute TTL (600 seconds)
    // SETEX is atomic, so the key is created and its expiration is set in one command.
    const reservationKey = `reservation:product:${id}:user-${userId}:rev-${reservationId}`;
    await redisService.client.setEx(reservationKey, 10, "reserved");

    // Add productId to user's cart in Redis Set
    await redisService.client.sAdd(cartKey, cartEntry);
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
    
    // Execute the checkout script in one single command, and handle it atomically
    const [successful, failed, debugLogs] = await redisService.client.eval(
      checkoutLuaScript,
      {
        keys: [cartKey],
        arguments: [userId],
      }
    );

    console.log("Lua Debug Logs:");
    console.log(debugLogs.join("\n"));

    if (successful.length === 0) {
      return res.status(400).json({
        message: "Checkout failed. No valid reservations found.",
        successful_purchases: [],
        expired_or_invalid: failed,
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Loop through only the items that were successfully validated by Redis
      for (const cartItem of successful) {
        const [productId] = cartItem.split(":");
        console.log("My purchase id:", productId);
        // A. Decrement the main inventory
        await client.query(
          "UPDATE products SET inventory = inventory - 1 WHERE id = $1 AND inventory > 0",
          [productId]
        );

        await client.query(
          "DELETE FROM reservations WHERE reservation_id = $1",
          [cartItem]
        );
        console.log("Not a integer reserve:", cartItem);
      }

      await client.query("COMMIT");
      logger.info(`Successfully processed checkout for user ${userId}.`);
    } catch (e) {
      await client.query("ROLLBACK");
      logger.error(
        "Database transaction failed. Initiating compensation logic.",
        e
      );

      // --- COMPENSATION LOGIC STARTS HERE ---
      // If the DB fails, we must return the stock to Redis for the items
      // that were successfully validated by the Lua script.
      const multi = redisService.client.multi();
      for (const cartItem of successful) {
        const [productId] = cartItem.split(":");
        const inventoryKey = `inventory:product:${productId}`;
        multi.incr(inventoryKey); // Queue up an INCR command for each failed item
      }
      // Execute all INCR commands in a single batch
      await multi.exec();
      logger.info(
        `Stock returned to Redis for ${successful.length} items due to DB failure.`
      );

      throw e; // Rethrow the original error
    } finally {
      client.release();
    }
    res.json({
      message: "Checkout complete.",
      successful: successful,
      failed: failed,
    });
  } catch (err) {
    logger.error("Error in checkout:", err);
    res.status(500).json({ error: "server error" });
  }
});

export default router;
