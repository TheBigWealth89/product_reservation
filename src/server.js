import "./config/loadEnv.js";
import express from "express";
import { createServer } from "http";
import { initSockets } from "./sockets/index.js";
import { syncInventoryToRedis } from "./db/sync-inventory.js";
import cookieParser from "cookie-parser";
import { redisClient, connectAll, pool } from "./db/connections.js";
import productRouter from "./routes/products.js";
import adminRouter from "./routes/admin.js";
import authRoute from "./routes/auth.route.js";
import webhookRouter from "./routes/webhook.js";
import { authenticate, requireRole } from "./middleware/authenticate.js";
import logger from "./utils/logger.js";
import { registerShutdownHandlers } from "./utils/shutdown.js";
import path from "path";
import { fileURLToPath } from "url";
import healthRouter from "./routes/health.route.js";

const port = 3000;
const app = express();
const httpServer = createServer(app);
const io = initSockets(httpServer);

// Health routes mounted first — must be reachable before auth and before
// dependencies are confirmed healthy (readiness probe runs at startup)
app.use("/", healthRouter);

app.use(cookieParser());
app.use("/", webhookRouter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use("/", authRoute);
app.use("/product", authenticate, productRouter);
app.use("/admin", authenticate, requireRole("admin"), adminRouter);

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
