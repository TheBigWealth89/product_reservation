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
    const key = `inventory:product-${id}`;

    const newInventory = await redisService.client.eval(luaScript, {
      keys: [key],
    });

    if (newInventory < 0) {
      return res.status(400).json({ error: "Out of stock" });
    }

    //Update the database 
    pool
      .query(
        "UPDATE products SET inventory = inventory - 1 WHERE id = $1 AND inventory > 0",
        [id]
      )
      .catch((err) => logger.error("Failed to sync inventory to DB:", err));

    logger.info(
      `Reservation successfully for product ${id}. New inventory: ${newInventory}`
    );

    res.json({ message: "Reservation successfully", inventory: newInventory });
  } catch (err) {
    logger.error("Error in reservation:", err);
    res.status(500).json({ error: "server error" });
  }
});

export default router;
