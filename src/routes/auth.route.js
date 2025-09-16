import Router from "express";
const authRoute = Router();

authRoute.post("/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASS
  ) {
    req.session.user = { username };
    res.redirect("/admin/dashboard");
  } else {
    res.render("login", { error: "Invalid credentials" });
  }
});

export default authRoute;
