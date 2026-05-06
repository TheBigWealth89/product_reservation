import "./config/loadEnv.js";
import express from "express";
import { createServer } from "http";
import { initSockets } from "./sockets/index.js";
import { syncInventoryToRedis } from "./db/sync-inventory.js";
import session from "express-session";
import { RedisStore } from "connect-redis";
import { redisClient, connectAll } from "./db/connections.js";
import productRouter from "./routes/products.js";
import adminRouter from "./routes/admin.js";
import authRoute from "./routes/auth.route.js";
import webhookRouter from "./routes/webhook.js";
import { isAuthenticated } from "./middleware/authenticate.js";
import logger from "./utils/logger.js";
import path from "path";
import { fileURLToPath } from "url";

const port = 3000;
const app = express();
const httpServer = createServer(app);
initSockets(httpServer);

// Health check endpoint for Docker/Kubernetes
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/", webhookRouter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure Redis Session Store
const redisStore = new RedisStore({
  client: redisClient,
  prefix: "prs_sess:",
});

app.use(
  session({
    store: redisStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // Set to true if using HTTPS
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24, // 1 day
    },
  })
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.get("/admin/login", (req, res) => {
  res.render("login", { error: null });
});

app.get("/admin/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/admin/login");
});

app.use("/auth", authRoute);
app.use("/product", productRouter);
app.use("/admin", isAuthenticated, adminRouter);

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
