const db = require("../db");

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect("/login");
  req.currentUser = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.session.userId);
  if (!req.currentUser) {
    req.session.destroy(() => {});
    return res.redirect("/login");
  }
  res.locals.currentUser = req.currentUser;
  next();
}

/**
 * Charge le membership de l'utilisateur courant pour la tontine demandée (:id dans l'URL)
 * et vérifie qu'il a bien accès (isolation stricte des données entre tontines — section 5).
 */
function loadMembership(req, res, next) {
  const tontineId = req.params.id || req.params.tontineId;
  const tontine = db.prepare(`SELECT * FROM tontines WHERE id = ?`).get(tontineId);
  if (!tontine) return res.status(404).render("error", { message: "Tontine introuvable." });

  const membership = db.prepare(`
    SELECT * FROM tontine_members WHERE tontine_id = ? AND user_id = ?
  `).get(tontineId, req.currentUser.id);

  if (!membership) {
    return res.status(403).render("error", { message: "Vous n'avez pas accès à cette tontine." });
  }

  req.tontine = tontine;
  req.membership = membership;
  res.locals.tontine = tontine;
  res.locals.membership = membership;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.membership.role)) {
      return res.status(403).render("error", { message: "Action réservée à : " + roles.join(", ") + "." });
    }
    next();
  };
}

module.exports = { requireAuth, loadMembership, requireRole };
