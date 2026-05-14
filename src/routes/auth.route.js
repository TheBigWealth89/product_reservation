import { Router } from "express";
import jwt from "jsonwebtoken";

const authRoute = Router();

// TODO: replace with database user lookup when real auth is implemented
const MOCK_USERS = {
  alice: { password: "pass123", id: "user-alice", role: "customer" },
  admin: { password: "adminpass", id: "admin-1", role: "admin" },
};

authRoute.get("/login", (req, res) => {
  res.render("login", { error: null });
});

authRoute.post("/login", (req, res) => {
  const { username, password } = req.body;
  const user = MOCK_USERS[username];

  if (user && user.password === password) {
    const payload = { sub: user.id, role: user.role };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "24h" });
    // logger.info("Token", token);

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 86400000,
    });

    if (user.role === "admin") {
      res.redirect("/admin/dashboard");
    } else {
      res.redirect("/product");
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
