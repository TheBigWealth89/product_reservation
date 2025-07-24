import express from "express";
const app = express();
const port = 3000;

app.set("view engine", "ejs");
app.use(express.json()); 
app.use(express.static("public")); // Serve static files



app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
