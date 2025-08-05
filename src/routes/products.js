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
    // Reservation ID: Unique identifier for each reservation key. 
    const reservationId = Date.now(); 
    const reservationKey = `reservation:product:${id}:user-${userId}:${reservationId}`;

    const newInventory = await redisService.client.eval(luaScript, {
      keys: [key],
    });

    console.log("New Inventory:", newInventory);

    if (newInventory < 0) {
      return res.status(400).json({ error: "Out of stock" });
    }

    // This create a temporary reservation key for this user with a 10-minute TTL (600 seconds)
    // SETEX is atomic, so the key is created and its expiration is set in one command.
    await redisService.client.setEx(reservationKey, 5, "reserved");

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
    });
  } catch (err) {
    logger.error("Error in reservation:", err);
    res.status(500).json({ error: "server error" });
  }
});

router.post("/:id/purchase", async (req, res) => {
  try {
    const { id } = req.params;
    //Assuming this would come from authentication session
    const userId = req.headers["x-user-id"] || "user-123";
    const reservationKey = `reservation:product:${id}:user-${userId}`;

    //DEL command returns the number of keys deleted (1 if it existed, 0 if not).
    const keyDeleted = await redisService.client.del(reservationKey);

    //If the key did'nt exist, it means their reservation has expired
    if (keyDeleted === 0) {
      await redisService.client.incr(`inventory:product-${id}`);
      return res
        .status(400)
        .json({ error: "Your reservation has expired. Please try again." });
    }

    // This is the "source of truth" update.
    await pool.query(
      "UPDATE products SET inventory = inventory - 1 WHERE id = $1",
      [id]
    );
    logger.info(`Purchase confirmed for product ${id} by user ${userId}.`);
    res.status(200).json({ message: "Purchase successful!" });
  } catch (error) {
    logger.error("Error in purchase:", err);
    res.status(500).json({ error: "server error" });
  }
});

export default router;
