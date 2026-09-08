import { Router } from "express";
import jwt from "jsonwebtoken";

const authRoute = Router();

authRoute.get("/login", (req, res) => {
  res.render("login", { error: null });
});

authRoute.post("/login", (req, res) => {
  const { username, password } = req.body;

  let user = null;
  // TODO: replace with database user lookup when real auth is implemented
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASS) {
    user = { id: "admin-1", role: "admin" };
  } else if (username === process.env.CUSTOMER_USERNAME && password === process.env.CUSTOMER_PASS) {
    user = { id: "user-alice", role: "customer" };
  }

  if (user) {
    const payload = { sub: user.id, role: user.role };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "24h" });

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 86400000,
    });

    if (user.role === "admin") {
      res.redirect("/admin/dashboard");
    } else {
      res.redirect("/product/1");
    }
  } else {
    res.render("login", { error: "Invalid credentials" });
  }
});

authRoute.get("/logout", (req, res) => {
  res.clearCookie("token");
  res.redirect("/login");
});

export default authRoute;
