import express from "express";
import { pool } from "../db/index.js";
import logger from "../utils/logger.js";
import redisService from "../service/redis.service.js";
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

router.post("/:id/reserve", async (req, res) => {
  try {
    const { id } = req.params;
    const key = `inventory:product-${id}`;

    //Read inventory from redis
    const inventory = await redisService.client.get(key);
    if (inventory === null) {
      return res.status(404).json({ error: "Product not found cache" });
    }

    //check inventory
    const inventoryNum = parseInt(inventory, 10);
    if (inventoryNum <= 0) {
      return res.status(400).json({ error: "Out of stock" });
    }

    //Decrement inventory
    const newInventory = await redisService.client.DECR(key);

    //Save back to DB
    await pool.query("UPDATE products SET inventory = $1 WHERE id = $2", [
      newInventory,
      id,
    ]);

    logger.info(
      `Reservation successfully for product ${id}. New inventory: ${newInventory}`
    );

    res.json({ message: "Reservation successfully", inventory: newInventory });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ error: "server error" });
  }
});

export default router;
