import express from "express";
import { connectAll } from "./connections.js";
import productRouter from "./routes/products.js";
import { syncInventoryToRedis } from "./db/sync-inventory.js";
import logger from "./utils/logger.js";
import path from "path";
import { fileURLToPath } from "url";

const port = 3000;
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// app.use(express.static("public")); // Serve static files

app.use("/product", productRouter);
connectAll()
  .then(async () => {
    await syncInventoryToRedis();
   
    app.listen(port, () => {
      logger.info(`Server running on port 3000`);
    });
  })
  .catch((err) => {
    logger.error("💥 Failed to start server:", err);
    process.exit(1);
  });
