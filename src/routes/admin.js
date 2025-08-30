import express from "express";
import purchaseQueue from "../queues/purchaseQueue.js";
import { pool, connectAll } from "../db/connections.js";
import returnStock from "../service/inventory.service.js";
import logger from "../utils/logger.js";

const router = express.Router();

//connection state tracking
let isInitialized = false;
async function initialize() {
  if (isInitialized) return;

  try {
    await connectAll();
    isInitialized = true;
    logger.info("Admin routes initialized successfully");
  } catch (err) {
    logger.error("Failed to initialize admin routes:", err);
    throw err;
  }
}
// Dashboard route with pagination
router.get("/dashboard", async (req, res) => {
  try {
    // await initialize();

    const page = parseInt(req.query.page) || 1;
    const pageSize = 10;
    const startIdx = (page - 1) * pageSize;

    const [failedJobs, total] = await Promise.all([
      purchaseQueue.getJobs(["failed"], startIdx, startIdx + pageSize - 1),
      purchaseQueue.getJobCounts(),
    ]);

    res.render("dashboard", {
      jobs: failedJobs,
      currentPage: page,
      totalPages: Math.ceil(total.failed / pageSize),
      user: req.session.user,
    });
  } catch (err) {
    logger.error("Dashboard error:", err);
    res.status(500).render("error", {
      message: "Failed to load dashboard",
      error: process.env.NODE_ENV === "development" ? err : null,
    });
  }
});

// Retry job
router.post("/jobs/:jobId/retry", async (req, res) => {
  try {
    await initialize();

    const { jobId } = req.params;
    const job = await purchaseQueue.getJob(jobId);

    if (!job || !(await job.isFailed())) {
      return res.status(404).send("Job not found or not failed");
    }

    await job.retry();
    logger.info(`Admin retried job ${jobId}`, {
      user: req.session.user.username,
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
  const client = await pool.connect();
  const { jobId } = req.params;
  try {
    await initialize();

    logger.info(`Job id ${jobId}`);
    const job = await purchaseQueue.getJob(jobId);

    if (!job || !(await job.isFailed())) {
      return res.status(404).send("Job not found or not failed");
    }

    await client.query("BEGIN");
    for (const cartItem of job.data?.successfulItems || []) {
      const [productId] = cartItem.split(":");

      //Check current status first
      const { rows } = await client.query(
        `SELECT status FROM reservations 
         WHERE reservation_id = $1 
         FOR UPDATE`,
        [cartItem]
      );

      if (rows[0]?.status !== "cancelled") {
        await client.query(
          `UPDATE reservations 
           SET status = 'cancelled', 
               updated_at = NOW() 
           WHERE reservation_id = $1`,
          [cartItem]
        );

        //Restore inventory
        await returnStock(productId);
      }
    }
    await client.query("COMMIT");
    await job.remove();
    logger.info(`Admin cancelled job ${jobId}`, {
      user: req.session.user.username,
    });

    res.redirect("/admin/dashboard");
  } catch (err) {
    await client
      .query("ROLLBACK")
      .catch((e) => logger.error("Rollback failed:", e));
    logger.error(`Failed to cancel job ${jobId}:`, err);
    res.status(500).json({
      error: "Failed to cancel job",
      details: process.env.NODE_ENV === "development" ? err.message : null,
    });
  } finally {
    client.release();
  }
});

export default router;
