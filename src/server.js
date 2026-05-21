import "./config/loadEnv.js";
import { createServer } from "http";
import { initSockets } from "./sockets/index.js";
import { syncInventoryToRedis } from "./db/sync-inventory.js";
import { redisClient, connectAll, pool } from "./db/connections.js";
import logger from "./utils/logger.js";
import { registerShutdownHandlers } from "./utils/shutdown.js";
import app from "./app.js";

const port = 3000;
const httpServer = createServer(app);
const io = initSockets(httpServer);

// Wait to start server until DB is connected

// Connect & sync
(async () => {
  try {
    await connectAll(); // Ensures Postgres + Redis are ready before starting

    try {
      await syncInventoryToRedis();
    } catch (syncErr) {
      logger.error("⚠️ Sync failed at startup; continuing to boot:", syncErr);
    }

    httpServer.listen(port, () => {
      logger.info(`🚀 Server with Socket.IO running on http://localhost:${port}`);
    });
  } catch (err) {
    logger.error("💥 Failed to start server:", err);
    process.exit(1);
  }
})();

registerShutdownHandlers({
  name: "API Server",
  httpServer,
  io,
  dbPool: pool,
  redisClient,
});
