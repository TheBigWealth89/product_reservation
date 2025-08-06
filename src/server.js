import express from "express";
import redisService from "./service/redis.service.js";
import productRouter from "./routes/products.js";
import { syncInventoryToRedis } from "./db/sync-inventory.js";
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
(async () => {
  await redisService.connect();
  await syncInventoryToRedis();
  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });
})();
