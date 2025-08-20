import express from "express";
import session from "express-session";
import { RedisStore } from "connect-redis";
import { redisClient } from "./db/connections.js";
import { connectAll } from "./db/connections.js";
import productRouter from "./routes/products.js";
import adminRouter from "./routes/admin.js";
import { syncInventoryToRedis } from "./db/sync-inventory.js";
import logger from "./utils/logger.js";
import path from "path";
import { fileURLToPath } from "url";

const port = 3000;
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const redisStore = new RedisStore({
  client: redisClient,
  prefix: "session:", // A recommended prefix for session keys in Redis
});

// Configure the session middleware to use the new store
app.use(
  session({
    store: redisStore,
    secret: process.env.SESSION_SECRET, // Make sure to set this in your environment variables
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production", // Use secure cookies in production
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24, // 24 hours
    },
  })
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
// app.use(express.static("public")); // Serve static files

// Basic auth middleware
function isAuthenticated(req, res, next) {
  if (req.session.user) return next();
  res.redirect("/admin/login");
}

app.get("/admin/login", (req, res) => {
  res.render("login", { error: null });
});

app.post("/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "admin" && password === "password123") {
    req.session.user = { username };
    res.redirect("/admin/dashboard");
  } else {
    res.render("login", { error: "Invalid credentials" });
  }
});

app.get("/admin/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/admin/login");
});

app.use("/product", productRouter);

app.use("/admin", isAuthenticated, adminRouter);
(async () => {
  try {
    await connectAll(); // ensures Postgres + Redis are ready before starting

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
