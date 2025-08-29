import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import "../src/workers/expiresWorker.js";
import session from "express-session";
import { connectAll } from "./db/connections.js";
import productRouter from "./routes/products.js";
import adminRouter from "./routes/admin.js";
import { syncInventoryToRedis } from "./db/sync-inventory.js";
import logger from "./utils/logger.js";
import path from "path";
import { fileURLToPath } from "url";

const port = 3000;
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Listen for new connection
io.on("connection", (socket) => {
  console.log("✅ A user connected with socket ID:", socket.id);

  // Listen for a message event from this client
  socket.io("chat-message", (msg) => {
    console.log("Message received", msg);
    // Broadcast the message to other clients
    io.emit("chat-message", msg);
  });

  socket.on("disconnect", () => {
    console.log("❌ User disconnected");
  });
});
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
// Run socket.io
httpServer.listen(3000, () => {
  console.log("🚀 Server with Socket.IO is running on port 3000");
});
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
