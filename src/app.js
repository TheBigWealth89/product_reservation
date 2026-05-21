import "./config/loadEnv.js";
import express from "express";
import cookieParser from "cookie-parser";
import productRouter from "./routes/products.js";
import adminRouter from "./routes/admin.js";
import authRoute from "./routes/auth.route.js";
import webhookRouter from "./routes/webhook.js";
import { authenticate, requireRole } from "./middleware/authenticate.js";
import path from "path";
import { fileURLToPath } from "url";
import healthRouter from "./routes/health.route.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cookieParser());
// Health routes mounted first — must be reachable before auth and before
// dependencies are confirmed healthy (readiness probe runs at startup)
app.use("/", healthRouter);

app.use("/", webhookRouter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use("/", authRoute);
app.use("/product", authenticate, productRouter);
app.use("/admin", authenticate, requireRole("admin"), adminRouter);

export default app;
