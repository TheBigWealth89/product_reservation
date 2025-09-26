import "./config/loadEnv.js";
import express from "express";
import { createServer } from "http";
import { initSockets } from "./sockets/index.js";
import { syncInventoryToRedis } from "./db/sync-inventory.js";
import session from "express-session";
import { connectAll } from "./db/connections.js";
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

app.use("/", webhookRouter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24,
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

// Run socket.io
httpServer.listen(3000, () => {
  console.log("🚀 Server with Socket.IO is running on port 3000");
});

// Connect & sync
(async () => {
  try {
    await connectAll(); // Ensures Postgres + Redis are ready before starting

    try {
      await syncInventoryToRedis();
    } catch (syncErr) {
      logger.error("⚠️ Sync failed at startup; continuing to boot:", syncErr);
    }

    app.listen(port, () => {
      logger.info(`🚀 Server running on http://localhost:${port}`);
    });
  } catch (err) {
    logger.error("💥 Failed to start server:", err);
    process.exit(1);
  }
})();
