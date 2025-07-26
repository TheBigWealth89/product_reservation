import express from "express";
const app = express();
import productRouter from "./routes/products.js";
import { pool } from "./db/index.js";
import path from "path";
import { fileURLToPath } from "url";
const port = 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// app.use(express.static("public")); // Serve static files
app.use(express.json());

app.use("/product", productRouter);

// app.get("/product/:id", async (req, res) => {
//   try {
//     const { id } = req.params;
//     const result = await pool.query("SELECT * FROM products WHERE id = $1", [
//       id,
//     ]);
//     if (result.rows.length === 0) {
//       return res.status(404).send("Product not found");
//     }
//     res.render("product", { product: result.rows[0] });
//   } catch (err) {
//     console.error(err);
//     res.status(500).send("Server error");
//   }
// });

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
