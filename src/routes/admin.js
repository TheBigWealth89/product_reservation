import express from "express";
import purchaseQueue from "../queues/purchaseQueue.js";
import { pool } from "../db/connections.js";
import inventoryService from "../service/inventory.service.js";
import logger from "../utils/logger.js";

const router = express.Router();


// Dashboard route with pagination
router.get("/dashboard", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = 10;
    const startIdx = (page - 1) * pageSize;

    const [failedJobs, total, productResult] = await Promise.all([
      purchaseQueue.getJobs(["failed"], startIdx, startIdx + pageSize - 1),
      purchaseQueue.getJobCounts(),
      pool.query("SELECT * FROM products ORDER BY id ASC"),
    ]);

    res.render("dashboard", {
      jobs: failedJobs,
      products: productResult.rows,
      currentPage: page,
      totalPages: Math.ceil(total.failed / pageSize),
      user: req.user,
    });
  } catch (err) {
    logger.error("Dashboard error:", err);
    res.status(500).render("error", {
      message: "Failed to load dashboard",
      error: process.env.NODE_ENV === "development" ? err : null,
    });
  }
});

// Update Inventory
router.post("/products/:id/inventory", async (req, res) => {
  try {
    const { id } = req.params;
    const { inventory } = req.body;

    if (isNaN(inventory) || parseInt(inventory) < 0) {
      return res.status(400).send("Invalid inventory count");
    }

    await inventoryService.updateProductInventory(id, parseInt(inventory));

    logger.info(`Admin ${req.user.id} manually set product ${id} inventory to ${inventory}`);
    res.redirect("/admin/dashboard");
  } catch (err) {
    logger.error(`Failed to update product ${id} inventory:`, err);
    res.status(500).json({
      error: "Failed to update inventory",
      details: process.env.NODE_ENV === "development" ? err.message : null,
    });
  }
});

// Retry job
router.post("/jobs/:jobId/retry", async (req, res) => {
  try {

    const { jobId } = req.params;
    const job = await purchaseQueue.getJob(jobId);

    if (!job || !(await job.isFailed())) {
      return res.status(404).send("Job not found or not failed");
    }

    await job.retry();
    logger.info(`Admin retried job ${jobId}`, {
      user: req.user.id,
    });
    res.redirect("/admin/dashboard");
  } catch (err) {
    logger.error(`Failed to retry job ${jobId}:`, err);
    res.status(500).json({
      error: "Failed to retry job",
      details: process.env.NODE_ENV === "development" ? err.message : null,
    });
  }
});

// Cancel job
router.post("/jobs/:jobId/cancel", async (req, res) => {
  const { jobId } = req.params;
  let client;
  try {

    logger.info(`Job id ${jobId}`);
    const job = await purchaseQueue.getJob(jobId);

    if (!job || !(await job.isFailed())) {
      return res.status(404).send("Job not found or not failed");
    }

    const { orderId } = job.data;

    client = await pool.connect();
    await client.query("BEGIN");

    const orderResult = await client.query(
      "SELECT product_id FROM orders WHERE id = $1",
      [orderId]
    );
    if (orderResult.rows.length > 0) {
      const { product_id } = orderResult.rows[0];

      //Check current status first
      const { rows } = await client.query(
        `SELECT status FROM orders 
         WHERE id = $1 
         FOR UPDATE`,
        [orderId]
      );

      if (rows[0]?.status !== "cancelled") {
        await client.query(
          `UPDATE orders 
             SET status = 'cancelled',
                 updated_at = NOW() 
             WHERE id = $1`,
          [orderId]
        );

        //Restore inventory
        await inventoryService.returnStock(product_id);
      }
    }

    await client.query("COMMIT");
    await job.remove();
    logger.info(`Admin cancelled job ${jobId}`, {
      user: req.user.id,
    });

    res.redirect("/admin/dashboard");
  } catch (err) {
    if (client) {
      await client
        .query("ROLLBACK")
        .catch((e) => logger.error("Rollback failed:", e));
    }
    logger.error(`Failed to cancel job ${jobId}:`, err);
    res.status(500).json({
      error: "Failed to cancel job",
      details: process.env.NODE_ENV === "development" ? err.message : null,
    });
  } finally {
    if (client) client.release();
  }
});

export default router;
