const express = require("express");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { logAudit } = require("../utils/audit");

const router = express.Router();

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

router.get("/", (req, res) => {
  if (req.session.userId) return res.redirect("/dashboard");
  res.redirect("/login");
});

// ---------- INSCRIPTION ----------
router.get("/register", (req, res) => {
  res.render("register", { error: null });
});

router.post("/register", (req, res) => {
  const { first_name, last_name, phone, consent } = req.body;
  if (!first_name || !last_name || !phone) {
    return res.render("register", { error: "Tous les champs sont obligatoires." });
  }
  if (!consent) {
    return res.render("register", { error: "Vous devez accepter la politique de confidentialité pour continuer." });
  }
  const existing = db.prepare(`SELECT * FROM users WHERE phone = ?`).get(phone.trim());
  if (existing) {
    return res.render("register", { error: "Ce numéro est déjà enregistré. Connectez-vous plutôt." });
  }
  const id = uuidv4();
  db.prepare(`INSERT INTO users (id, first_name, last_name, phone) VALUES (?, ?, ?, ?)`)
    .run(id, first_name.trim(), last_name.trim(), phone.trim());
  logAudit({ actorUserId: id, action: "user_registered", entity: "user", entityId: id, newValue: { phone } });

  req.session.pendingPhone = phone.trim();
  return sendOtp(phone.trim(), res, "/dashboard");
});

// ---------- CONNEXION (demande d'OTP) ----------
router.get("/login", (req, res) => {
  res.render("login", { error: null });
});

router.post("/login", (req, res) => {
  const { phone } = req.body;
  const user = db.prepare(`SELECT * FROM users WHERE phone = ?`).get((phone || "").trim());
  if (!user) {
    return res.render("login", { error: "Aucun compte associé à ce numéro. Inscrivez-vous d'abord." });
  }
  req.session.pendingPhone = phone.trim();
  return sendOtp(phone.trim(), res, "/dashboard");
});

function sendOtp(phone, res, redirectTo) {
  const code = generateOtp();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO otp_codes (phone, code, expires_at) VALUES (?, ?, ?)`).run(phone, code, expiresAt);
  // Simulation d'envoi SMS : en dev, le code est affiché directement à l'écran.
  console.log(`[OTP SIMULÉ] ${phone} -> ${code} (valide 5 min)`);
  res.render("otp", { phone, devCode: code, redirectTo, error: null });
}

router.post("/otp/verify", (req, res) => {
  const { phone, code, redirectTo } = req.body;
  const row = db.prepare(`
    SELECT * FROM otp_codes WHERE phone = ? AND code = ? AND consumed = 0
    ORDER BY created_at DESC LIMIT 1
  `).get(phone, code);

  if (!row || new Date(row.expires_at) < new Date()) {
    return res.render("otp", { phone, devCode: null, redirectTo, error: "Code invalide ou expiré. Veuillez réessayer." });
  }

  db.prepare(`UPDATE otp_codes SET consumed = 1 WHERE id = ?`).run(row.id);
  const user = db.prepare(`SELECT * FROM users WHERE phone = ?`).get(phone);
  req.session.userId = user.id;
  logAudit({ actorUserId: user.id, action: "user_login", entity: "user", entityId: user.id });
  res.redirect(redirectTo && redirectTo.startsWith("/") ? redirectTo : "/dashboard");
});

router.post("/otp/resend", (req, res) => {
  const { phone, redirectTo } = req.body;
  return sendOtp(phone, res, redirectTo || "/dashboard");
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

module.exports = router;
