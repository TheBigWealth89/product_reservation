// Basic auth middleware
export function isAuthenticated(req, res, next) {
  if (req.session.user) return next();
  res.redirect("/admin/login");
}