import express from "express";
import { pool } from "../db/index.js";

const router = express.Router();

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    console.log("Incoming ID ", id);
    const result = await pool.query("SELECT * FROM products WHERE id=$1", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }
    // res.json(result.rows[0]);
    res.render("product", { product: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server error" });
  }
});

router.post("/:id/reserve", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM products WHERE id =$1", [
      id,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }

    const product = result.rows[0];

    //check inventory
    if (product.inventory <= 0) {
      return res.status(400).json({ error: "out of stock" });
    }

    //Decrement inventory
    const newInventory = product.inventory - 1;
    //Save back to DB
    await pool.query("UPDATE products SET inventory = $1 WHERE id = $2", [
      newInventory,
      id,
    ]);
    res.json({ message: "Reservation successfully", inventory: newInventory });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server error" });
  }
});

export default router;
