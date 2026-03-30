const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const passwordPolicyMessage =
  "Use at least 12 characters with upper and lower case letters, a number, and a symbol.";

function sanitizeUsername(username) {
  return String(username || "").trim();
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function validatePasswordStrength(password) {
  if (password.length < 12) {
    return { valid: false, message: passwordPolicyMessage };
  }

  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    return { valid: false, message: passwordPolicyMessage };
  }

  return { valid: true };
}

function createCsrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }

  next();
}

function validateCsrf(req, res, next) {
  if (req.body._csrf !== req.session.csrfToken) {
    return res.status(403).render("error", {
      pageTitle: "Security check failed",
      currentUser: res.locals.currentUser,
      errors: ["Your session security token was invalid. Please refresh the page and try again."]
    });
  }

  next();
}

function attachLocals(req, res, next) {
  res.locals.isAuthenticated = Boolean(req.session.userId);
  res.locals.csrfToken = req.session.csrfToken;
  res.locals.currentUser = null;
  next();
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    return res.redirect("/login");
  }

  // Lazy-load to avoid circular dependency at module load time.
  const { findUserById } = require("../storage/users");
  const user = findUserById(req.session.userId);

  if (!user || !user.is_admin) {
    return res.status(403).render("error", {
      pageTitle: "Access denied",
      currentUser: user || null,
      errors: ["You do not have permission to access this page."]
    });
  }

  next();
}

module.exports = {
  attachLocals,
  createCsrfToken,
  hashPassword,
  passwordPolicyMessage,
  requireAdmin,
  requireAuth,
  sanitizeUsername,
  validateCsrf,
  validatePasswordStrength,
  verifyPassword
};
