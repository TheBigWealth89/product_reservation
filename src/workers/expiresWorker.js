// redisClient is passed to registerShutdownHandlers for graceful connection teardown
import { pool, redisClient } from "../db/connections.js";
import logger from "../utils/logger.js";
import { registerShutdownHandlers } from "../utils/shutdown.js";
import { expiryProcessor } from "./processors/expiry.processor.js";

class ExpirationCleanup {
  constructor() {
    this.isRunning = false;
    this.interval = 30000; // 30 seconds
    this.timer = null;
    this._runningPromise = Promise.resolve(); // tracks the active cleanupExpired call
  }

  async cleanupExpired() {
    if (this.isRunning) return;
    this.isRunning = true;
    // Expose the promise so stop() can await any in-flight run
    this._runningPromise = this._doCleanup();
    await this._runningPromise;
  }

  async _doCleanup() {
    try {
      await expiryProcessor();
    } finally {
      this.isRunning = false;
    }
  }

  start() {
    logger.info("Starting expiration cleanup worker (30s interval)");
    this.timer = setInterval(() => this.cleanupExpired(), this.interval);
    this.cleanupExpired(); // Run immediately
  }

  async stop() {
    clearInterval(this.timer); // stop future poll cycles
    await this._runningPromise; // wait for any in-flight run to finish
    logger.info("[Expires Worker] In-flight cleanup awaited");
  }
}

// Start the cleanup
const cleanup = new ExpirationCleanup();
cleanup.start();

registerShutdownHandlers({
  name: "Expires Worker",
  stopTimer: () => cleanup.stop(), // async — awaited inside shutdown helper
  dbPool: pool,
  redisClient,
});

export default cleanup;
