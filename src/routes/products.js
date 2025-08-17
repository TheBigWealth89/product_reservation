import express from "express";
import { redisClient, pool } from "../connections.js";
import logger from "../utils/logger.js";
import purchaseQueue from "../queues/purchaseQueue.js";
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
    const inventory = await redisClient.get(`inventory:product-${id}`);
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
    const inventoryKey = `inventory:product-${id}`;
    const cartKey = `cart:user-${userId}`;

    // Run atomic Lua script to decrement inventory
    const newInventory = await redisClient.eval(reserveLuaScript, {
      keys: [inventoryKey],
    });

    if (newInventory < 0) {
      return res.status(400).json({ error: "Out of stock" });
    }

    // Generate clean reservation ID
    const reservationId = uuidv4();
    const cartEntry = `${id}:rev-${reservationId}`;
    console.log("My cartEntry:", cartEntry);
    const reservationKey = `reservation:product:${id}:user-${userId}:rev-${reservationId}`;

    const tenMinutesFromNow = new Date(Date.now() + 60000);

    //Save to DB
    await pool.query(
      "INSERT INTO reservations (product_id, user_id, expires_at, reservation_id) VALUES ($1, $2, $3, $4)",
      [id, userId, tenMinutesFromNow, cartEntry]
    );

    // Set Redis reservation key with TTL
    await redisClient.setEx(reservationKey, 600, "reserved");

    // Add product to user's cart in Redis Set
    await redisClient.sAdd(cartKey, cartEntry);
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
      expiredAt: tenMinutesFromNow,
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
    const [successful, failed, debugLogs] = await redisClient.eval(
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

    if (successful.length > 0) {
      const job = await purchaseQueue.add(
        "process-purchase",
        {
          successfulItems: successful,
          userId: userId,
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
      logger.info(`processed order added to queue for user ${userId}.`);
      res.status(202).json({
        message: "Checkout accepted. Your order is being processed.",
        jobId: job.id,
      });
    }
  } catch (err) {
    logger.error("Error in checkout:", err);
    res.status(500).json({ error: "server error" });
  }
});

export default router;
