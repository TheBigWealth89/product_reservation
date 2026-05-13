import express from "express";
import { pool, redisClient } from "../db/connections.js";
import purchaseQueue from "../queues/purchaseQueue.js";
import logger from "../utils/logger.js";
import { authenticate, requireRole } from "../middleware/authenticate.js";

const healthRouter = express.Router();

logger.info('Health routes initialised (/health, /ready, /metrics)');

// Liveness probe
healthRouter.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    process: "api-server",
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Readiness probe
healthRouter.get("/ready", async (req, res) => {
  const pgCheck = async () => {
    const start = Date.now();
    try {
      await pool.query('SELECT 1');
      return { dependency: "postgres", status: "ok", latency_ms: Date.now() - start };
    } catch (err) {
      return { dependency: "postgres", status: "error", latency_ms: Date.now() - start, error: err.message };
    }
  };

  const redisCheck = async () => {
    const start = Date.now();
    try {
      const result = await redisClient.ping();
      if (result !== "PONG" && result?.toString() !== "PONG") {
        throw new Error(`Unexpected Redis ping response: ${result}`);
      }
      return { dependency: "redis", status: "ok", latency_ms: Date.now() - start };
    } catch (err) {
      return { dependency: "redis", status: "error", latency_ms: Date.now() - start, error: err.message };
    }
  };

  const bullmqCheck = async () => {
    const start = Date.now();
    try {
      const counts = await purchaseQueue.getJobCounts();
      return { dependency: "bullmq", status: "ok", latency_ms: Date.now() - start, job_counts: counts };
    } catch (err) {
      return { dependency: "bullmq", status: "error", latency_ms: Date.now() - start, error: err.message };
    }
  };

  const results = await Promise.allSettled([
    Promise.race([
      pgCheck(),
      new Promise(resolve => setTimeout(() => resolve({ dependency: "postgres", status: "error", latency_ms: 3000, error: "timeout" }), 3000))
    ]),
    Promise.race([
      redisCheck(),
      new Promise(resolve => setTimeout(() => resolve({ dependency: "redis", status: "error", latency_ms: 3000, error: "timeout" }), 3000))
    ]),
    Promise.race([
      bullmqCheck(),
      new Promise(resolve => setTimeout(() => resolve({ dependency: "bullmq", status: "error", latency_ms: 3000, error: "timeout" }), 3000))
    ])
  ]);

  const checks = {};
  let isDegraded = false;

  for (const result of results) {
    // Because we handle errors internally, result.status should always be 'fulfilled'
    const data = result.value;
    const { dependency, ...details } = data;
    checks[dependency] = details;
    if (details.status === "error") {
      isDegraded = true;
    }
  }

  const responseStatus = isDegraded ? "degraded" : "ok";
  const httpStatus = isDegraded ? 503 : 200;

  if (isDegraded) {
    logger.warn(`Readiness probe failed (503)`, { checks });
  }

  res.status(httpStatus).json({
    status: responseStatus,
    process: "api-server",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks
  });
});

// Metrics endpoint
healthRouter.get("/metrics", authenticate, requireRole('admin'), async (req, res) => {
  const fetchQueueCounts = async () => {
    try {
      return await purchaseQueue.getJobCounts();
    } catch (err) {
      return null;
    }
  };

  const fetchInventory = async () => {
    try {
      // NOTE: keys() is O(N) and blocking. Acceptable here, use SCAN in production.
      const keys = await redisClient.keys('inventory:product-*');
      if (keys.length === 0) return {};
      const values = await redisClient.mget(...keys);
      const inventory = {};
      keys.forEach((key, index) => {
        if (values[index] !== null) {
          const productId = key.replace('inventory:product-', '');
          inventory[`product_${productId}`] = parseInt(values[index], 10);
        }
      });
      return inventory;
    } catch (err) {
      return null;
    }
  };

  const fetchRedisMemory = async () => {
    try {
      const info = await redisClient.info('memory');
      const lines = info.split('\n');
      const usedMemoryLine = lines.find(line => line.startsWith('used_memory:'));
      if (usedMemoryLine) {
        const bytes = parseInt(usedMemoryLine.split(':')[1], 10);
        return parseFloat((bytes / 1048576).toFixed(2));
      }
      return null;
    } catch (err) {
      return null;
    }
  };

  const [queueCounts, inventory, redisMemory] = await Promise.allSettled([
    fetchQueueCounts(),
    fetchInventory(),
    fetchRedisMemory()
  ]);

  const mem = process.memoryUsage();

  res.status(200).json({
    timestamp: new Date().toISOString(),
    process: {
      uptime_seconds: process.uptime(),
      memory_mb: {
        rss: parseFloat((mem.rss / 1048576).toFixed(2)),
        heap_used: parseFloat((mem.heapUsed / 1048576).toFixed(2)),
        heap_total: parseFloat((mem.heapTotal / 1048576).toFixed(2)),
      },
      node_version: process.version
    },
    queue: queueCounts.value || null,
    inventory: inventory.value || null,
    redis_memory_mb: redisMemory.value || null
  });
});

export default healthRouter;
