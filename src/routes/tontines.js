const express = require("express");
const multer = require("multer");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { requireAuth, loadMembership, requireRole } = require("../middleware/auth");
const { logAudit, notify, notifyBothChannels } = require("../utils/audit");
const { generateCycles, runArrearsCheck } = require("../utils/business");

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, "..", "..", "public", "uploads"),
    filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname)),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

function genInviteCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ---------- DASHBOARD ----------
router.get("/dashboard", requireAuth, (req, res) => {
  const myTontines = db.prepare(`
    SELECT t.*, tm.role as my_role, tm.status as my_status,
      (SELECT COUNT(*) FROM tontine_members WHERE tontine_id = t.id AND status != 'excluded') as members_count
    FROM tontines t
    JOIN tontine_members tm ON tm.tontine_id = t.id
    WHERE tm.user_id = ?
    ORDER BY t.created_at DESC
  `).all(req.currentUser.id);

  for (const t of myTontines) runArrearsCheck(t.id);

  const enriched = myTontines.map((t) => {
    const nextCycle = db.prepare(`
      SELECT cy.*, u.first_name, u.last_name FROM cycles cy
      LEFT JOIN tontine_members bm ON bm.id = cy.beneficiary_member_id
      LEFT JOIN users u ON u.id = bm.user_id
      WHERE cy.tontine_id = ? AND cy.status != 'closed'
      ORDER BY cy.cycle_number ASC LIMIT 1
    `).get(t.id);
    return { ...t, nextCycle };
  });

  const notifications = db.prepare(`
    SELECT * FROM notifications WHERE user_id = ? AND channel = 'in_app'
    ORDER BY created_at DESC LIMIT 8
  `).all(req.currentUser.id);

  res.render("dashboard", { tontines: enriched, notifications });
});

router.post("/notifications/:id/read", requireAuth, (req, res) => {
  db.prepare(`UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?`).run(req.params.id, req.currentUser.id);
  res.redirect("back");
});

// ---------- CREATION D'UNE TONTINE ----------
router.get("/tontines/new", requireAuth, (req, res) => {
  res.render("tontine-new", { error: null });
});

router.post("/tontines/new", requireAuth, (req, res) => {
  const {
    name, description, amount, frequency, start_date, num_cycles,
    max_members, rotation_mode, proof_threshold, double_validation, rules,
  } = req.body;

  if (!name || !amount || !frequency || !start_date || !num_cycles || !max_members || !rotation_mode) {
    return res.render("tontine-new", { error: "Merci de remplir tous les champs obligatoires." });
  }

  const id = uuidv4();
  const inviteCode = genInviteCode();

  db.prepare(`
    INSERT INTO tontines (id, name, description, amount, frequency, start_date, num_cycles, max_members,
      rotation_mode, proof_threshold, double_validation, rules, invite_code, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, name.trim(), description || "", parseFloat(amount), frequency, start_date,
    parseInt(num_cycles, 10), parseInt(max_members, 10), rotation_mode,
    parseFloat(proof_threshold || 0), double_validation ? 1 : 0, rules || "", inviteCode, req.currentUser.id
  );

  const memberId = uuidv4();
  db.prepare(`
    INSERT INTO tontine_members (id, tontine_id, user_id, role, status) VALUES (?, ?, ?, 'admin', 'active')
  `).run(memberId, id, req.currentUser.id);

  logAudit({ tontineId: id, actorUserId: req.currentUser.id, action: "tontine_created", entity: "tontine", entityId: id, newValue: req.body });

  res.redirect(`/tontines/${id}`);
});

// ---------- REJOINDRE UNE TONTINE ----------
router.get("/tontines/join", requireAuth, (req, res) => {
  res.render("tontine-join", { error: null });
});

router.post("/tontines/join", requireAuth, (req, res) => {
  const code = (req.body.invite_code || "").trim().toUpperCase();
  const tontine = db.prepare(`SELECT * FROM tontines WHERE invite_code = ?`).get(code);
  if (!tontine) return res.render("tontine-join", { error: "Code d'invitation invalide." });

  const already = db.prepare(`SELECT * FROM tontine_members WHERE tontine_id = ? AND user_id = ?`).get(tontine.id, req.currentUser.id);
  if (already) return res.redirect(`/tontines/${tontine.id}`);

  const count = db.prepare(`SELECT COUNT(*) n FROM tontine_members WHERE tontine_id = ? AND status != 'excluded'`).get(tontine.id).n;
  if (count >= tontine.max_members) {
    return res.render("tontine-join", { error: "Cette tontine a atteint son nombre maximal de membres." });
  }

  const memberId = uuidv4();
  db.prepare(`INSERT INTO tontine_members (id, tontine_id, user_id, role, status) VALUES (?, ?, ?, 'member', 'active')`)
    .run(memberId, tontine.id, req.currentUser.id);

  logAudit({ tontineId: tontine.id, actorUserId: req.currentUser.id, action: "member_joined", entity: "tontine_member", entityId: memberId });

  const admin = db.prepare(`
    SELECT u.id FROM tontine_members tm JOIN users u ON u.id = tm.user_id
    WHERE tm.tontine_id = ? AND tm.role = 'admin' LIMIT 1
  `).get(tontine.id);
  if (admin) notify({ userId: admin.id, tontineId: tontine.id, title: "Nouveau membre", body: `${req.currentUser.first_name} a rejoint la tontine.` });

  res.redirect(`/tontines/${tontine.id}`);
});

// ---------- DETAIL / TABLEAU DE BORD D'UNE TONTINE ----------
router.get("/tontines/:id", requireAuth, loadMembership, (req, res) => {
  runArrearsCheck(req.tontine.id);

  const members = db.prepare(`
    SELECT tm.*, u.first_name, u.last_name, u.phone FROM tontine_members tm
    JOIN users u ON u.id = tm.user_id WHERE tm.tontine_id = ? ORDER BY tm.joined_at ASC
  `).all(req.tontine.id);

  const cycles = db.prepare(`
    SELECT cy.*, u.first_name as ben_first, u.last_name as ben_last FROM cycles cy
    LEFT JOIN tontine_members bm ON bm.id = cy.beneficiary_member_id
    LEFT JOIN users u ON u.id = bm.user_id
    WHERE cy.tontine_id = ? ORDER BY cy.cycle_number ASC
  `).all(req.tontine.id);

  const openDisputes = db.prepare(`SELECT COUNT(*) n FROM disputes WHERE tontine_id = ? AND status IN ('open','in_progress')`).get(req.tontine.id).n;
  const membersInDefault = members.filter((m) => m.status === "default").length;

  const activeMembersCount = members.filter((m) => m.status !== "excluded").length;
  const totalExpected = cycles.length > 0 ? cycles[0].expected_amount * cycles.length : 0;
  const totalCollected = db.prepare(`
    SELECT COALESCE(SUM(paid_amount),0) s FROM contributions c JOIN cycles cy ON cy.id=c.cycle_id WHERE cy.tontine_id=?
  `).get(req.tontine.id).s;
  const paymentRate = totalExpected > 0 ? Math.round((totalCollected / totalExpected) * 100) : 0;

  res.render("tontine-detail", {
    members, cycles, openDisputes, membersInDefault, activeMembersCount,
    paymentRate, totalCollected, totalExpected,
  });
});

// ---------- MEMBRES : gestion (admin) ----------
router.post("/tontines/:id/members/:memberId/exclude", requireAuth, loadMembership, requireRole("admin"), (req, res) => {
  const { reason } = req.body;
  const member = db.prepare(`SELECT * FROM tontine_members WHERE id = ? AND tontine_id = ?`).get(req.params.memberId, req.tontine.id);
  if (!member) return res.status(404).render("error", { message: "Membre introuvable." });
  if (member.role === "admin") return res.status(400).render("error", { message: "Impossible d'exclure l'administrateur." });

  db.prepare(`UPDATE tontine_members SET status = 'excluded', exclusion_reason = ? WHERE id = ?`).run(reason || "Non précisé", member.id);
  logAudit({
    tontineId: req.tontine.id, actorUserId: req.currentUser.id, action: "member_excluded",
    entity: "tontine_member", entityId: member.id, oldValue: member.status, newValue: { status: "excluded", reason },
  });
  notify({ userId: member.user_id, tontineId: req.tontine.id, title: "Exclusion de la tontine", body: `Motif : ${reason || "non précisé"}` });

  res.redirect(`/tontines/${req.tontine.id}`);
});

router.post("/tontines/:id/members/:memberId/role", requireAuth, loadMembership, requireRole("admin"), (req, res) => {
  const { role } = req.body; // treasurer | member
  if (!["treasurer", "member"].includes(role)) return res.redirect(`/tontines/${req.tontine.id}`);
  const member = db.prepare(`SELECT * FROM tontine_members WHERE id = ? AND tontine_id = ?`).get(req.params.memberId, req.tontine.id);
  if (!member || member.role === "admin") return res.redirect(`/tontines/${req.tontine.id}`);

  db.prepare(`UPDATE tontine_members SET role = ? WHERE id = ?`).run(role, member.id);
  logAudit({ tontineId: req.tontine.id, actorUserId: req.currentUser.id, action: "member_role_changed", entity: "tontine_member", entityId: member.id, oldValue: member.role, newValue: role });

  res.redirect(`/tontines/${req.tontine.id}`);
});

// ---------- TIRAGE AU SORT ----------
router.post("/tontines/:id/draw", requireAuth, loadMembership, requireRole("admin"), (req, res) => {
  const existingCycles = db.prepare(`SELECT * FROM cycles WHERE tontine_id = ?`).get(req.tontine.id);
  const members = db.prepare(`SELECT * FROM tontine_members WHERE tontine_id = ? AND status != 'excluded'`).all(req.tontine.id);

  if (!existingCycles) {
    generateCycles(req.tontine, members.length);
  }

  const cycles = db.prepare(`SELECT * FROM cycles WHERE tontine_id = ? AND beneficiary_member_id IS NULL ORDER BY cycle_number ASC`).all(req.tontine.id);
  if (cycles.length === 0) {
    return res.status(400).render("error", { message: "Le tirage a déjà été effectué pour tous les cycles." });
  }

  let order;
  if (req.tontine.rotation_mode === "random_draw") {
    order = [...members].sort(() => Math.random() - 0.5);
  } else {
    order = [...members].sort((a, b) => new Date(a.joined_at) - new Date(b.joined_at));
  }

  const update = db.prepare(`UPDATE cycles SET beneficiary_member_id = ? WHERE id = ?`);
  const assign = db.transaction(() => {
    cycles.forEach((c, i) => {
      const beneficiary = order[i % order.length];
      update.run(beneficiary.id, c.id);
    });
  });
  assign();

  const resultSummary = cycles.map((c, i) => ({ cycle: c.cycle_number, member_id: order[i % order.length].id }));
  db.prepare(`INSERT INTO draws (id, tontine_id, result_json, drawn_by) VALUES (?, ?, ?, ?)`)
    .run(uuidv4(), req.tontine.id, JSON.stringify(resultSummary), req.currentUser.id);

  logAudit({
    tontineId: req.tontine.id, actorUserId: req.currentUser.id, action: "draw_performed",
    entity: "tontine", entityId: req.tontine.id, newValue: resultSummary,
  });

  members.forEach((m) => notify({ userId: m.user_id, tontineId: req.tontine.id, title: "Tirage au sort effectué", body: "Consultez le calendrier des bénéficiaires." }));

  res.redirect(`/tontines/${req.tontine.id}/calendar`);
});

router.get("/tontines/:id/calendar", requireAuth, loadMembership, (req, res) => {
  const cycles = db.prepare(`
    SELECT cy.*, u.first_name as ben_first, u.last_name as ben_last FROM cycles cy
    LEFT JOIN tontine_members bm ON bm.id = cy.beneficiary_member_id
    LEFT JOIN users u ON u.id = bm.user_id
    WHERE cy.tontine_id = ? ORDER BY cy.cycle_number ASC
  `).all(req.tontine.id);
  res.render("calendar", { cycles });
});

// ---------- COTISATIONS ----------
router.get("/tontines/:id/cycles/:cycleId/contributions", requireAuth, loadMembership, (req, res) => {
  const cycle = db.prepare(`SELECT * FROM cycles WHERE id = ? AND tontine_id = ?`).get(req.params.cycleId, req.tontine.id);
  if (!cycle) return res.status(404).render("error", { message: "Cycle introuvable." });

  const contributions = db.prepare(`
    SELECT c.*, u.first_name, u.last_name FROM contributions c
    JOIN tontine_members tm ON tm.id = c.member_id
    JOIN users u ON u.id = tm.user_id
    WHERE c.cycle_id = ? ORDER BY u.first_name ASC
  `).all(cycle.id);

  res.render("contributions", { cycle, contributions });
});

router.post(
  "/tontines/:id/contributions/:contribId/record",
  requireAuth, loadMembership, requireRole("admin", "treasurer"),
  upload.single("proof"),
  (req, res) => {
    const { paid_amount, payment_date, payment_method } = req.body;
    const contrib = db.prepare(`SELECT * FROM contributions c JOIN cycles cy ON cy.id=c.cycle_id WHERE c.id = ? AND cy.tontine_id = ?`)
      .get(req.params.contribId, req.tontine.id);
    if (!contrib) return res.status(404).render("error", { message: "Cotisation introuvable." });

    const amount = parseFloat(paid_amount);
    const proofRequired = amount >= req.tontine.proof_threshold && req.tontine.proof_threshold > 0;
    if (proofRequired && !req.file) {
      return res.status(400).render("error", {
        message: `Une preuve de paiement est obligatoire pour les cotisations à partir de ${req.tontine.proof_threshold} ${req.tontine.currency}.`,
      });
    }

    const proofPath = req.file ? "/uploads/" + req.file.filename : null;
    const status = amount >= contrib.expected_amount ? "paid" : "late";

    db.prepare(`
      UPDATE contributions SET paid_amount = ?, payment_date = ?, payment_method = ?, proof_path = COALESCE(?, proof_path),
      status = ?, validated_by = ?, validated_at = datetime('now') WHERE id = ?
    `).run(amount, payment_date || new Date().toISOString().slice(0, 10), payment_method, proofPath, status, req.currentUser.id, contrib.id);

    db.prepare(`UPDATE cycles SET collected_amount = collected_amount + ? WHERE id = ?`).run(amount, contrib.cycle_id);

    logAudit({
      tontineId: req.tontine.id, actorUserId: req.currentUser.id, action: "contribution_recorded",
      entity: "contribution", entityId: contrib.id, oldValue: { status: contrib.status }, newValue: { amount, status },
    });

    const member = db.prepare(`SELECT * FROM tontine_members WHERE id = ?`).get(contrib.member_id);
    notify({ userId: member.user_id, tontineId: req.tontine.id, title: "Cotisation enregistrée", body: `Montant : ${amount} ${req.tontine.currency}` });

    res.redirect(`/tontines/${req.tontine.id}/cycles/${contrib.cycle_id}/contributions`);
  }
);

// ---------- CONFIRMATION DE LA REMISE DU POT ----------
router.post("/tontines/:id/cycles/:cycleId/payout/confirm", requireAuth, loadMembership, requireRole("admin", "treasurer"), (req, res) => {
  const cycle = db.prepare(`SELECT * FROM cycles WHERE id = ? AND tontine_id = ?`).get(req.params.cycleId, req.tontine.id);
  if (!cycle) return res.status(404).render("error", { message: "Cycle introuvable." });

  const field = req.membership.role === "admin" ? "payout_confirmed_admin_at" : "payout_confirmed_treasurer_at";
  db.prepare(`UPDATE cycles SET ${field} = datetime('now') WHERE id = ?`).run(cycle.id);

  const updated = db.prepare(`SELECT * FROM cycles WHERE id = ?`).get(cycle.id);
  const needsBoth = !!req.tontine.double_validation;
  const bothDone = updated.payout_confirmed_admin_at && updated.payout_confirmed_treasurer_at;
  const oneDone = updated.payout_confirmed_admin_at || updated.payout_confirmed_treasurer_at;

  let newStatus = cycle.status;
  if (needsBoth && bothDone) newStatus = "closed";
  else if (!needsBoth && oneDone) newStatus = "closed";
  else newStatus = "ready_for_payout";

  db.prepare(`UPDATE cycles SET status = ? WHERE id = ?`).run(newStatus, cycle.id);

  logAudit({
    tontineId: req.tontine.id, actorUserId: req.currentUser.id, action: "payout_confirmed",
    entity: "cycle", entityId: cycle.id, newValue: { role: req.membership.role, newStatus },
  });

  if (newStatus === "closed") {
    const beneficiary = db.prepare(`SELECT * FROM tontine_members WHERE id = ?`).get(cycle.beneficiary_member_id);
    if (beneficiary) notify({ userId: beneficiary.user_id, tontineId: req.tontine.id, title: "Remise du pot confirmée", body: `Le pot du cycle ${cycle.cycle_number} vous a été remis. Merci de confirmer réception.` });
  }

  res.redirect(`/tontines/${req.tontine.id}`);
});

// ---------- LITIGES ----------
router.get("/tontines/:id/disputes", requireAuth, loadMembership, (req, res) => {
  const disputes = db.prepare(`
    SELECT d.*, u.first_name, u.last_name FROM disputes d
    JOIN users u ON u.id = d.raised_by
    WHERE d.tontine_id = ? ORDER BY d.created_at DESC
  `).all(req.tontine.id);
  res.render("disputes", { disputes });
});

router.post("/tontines/:id/disputes/new", requireAuth, loadMembership, (req, res) => {
  const { subject, description, cycle_id, contribution_id } = req.body;
  const id = uuidv4();
  db.prepare(`
    INSERT INTO disputes (id, tontine_id, raised_by, contribution_id, cycle_id, subject, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.tontine.id, req.currentUser.id, contribution_id || null, cycle_id || null, subject, description || "");

  logAudit({ tontineId: req.tontine.id, actorUserId: req.currentUser.id, action: "dispute_opened", entity: "dispute", entityId: id, newValue: { subject } });

  const admin = db.prepare(`SELECT u.id FROM tontine_members tm JOIN users u ON u.id=tm.user_id WHERE tm.tontine_id=? AND tm.role='admin'`).get(req.tontine.id);
  if (admin) notify({ userId: admin.id, tontineId: req.tontine.id, title: "Nouveau litige signalé", body: subject });

  res.redirect(`/tontines/${req.tontine.id}/disputes`);
});

router.post("/tontines/:id/disputes/:disputeId/resolve", requireAuth, loadMembership, requireRole("admin"), (req, res) => {
  const { status, resolution_note } = req.body; // resolved | rejected | in_progress
  const dispute = db.prepare(`SELECT * FROM disputes WHERE id = ? AND tontine_id = ?`).get(req.params.disputeId, req.tontine.id);
  if (!dispute) return res.status(404).render("error", { message: "Litige introuvable." });

  db.prepare(`
    UPDATE disputes SET status = ?, resolution_note = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?
  `).run(status, resolution_note || "", req.currentUser.id, dispute.id);

  logAudit({
    tontineId: req.tontine.id, actorUserId: req.currentUser.id, action: "dispute_resolved",
    entity: "dispute", entityId: dispute.id, oldValue: dispute.status, newValue: { status, resolution_note },
  });

  notify({ userId: dispute.raised_by, tontineId: req.tontine.id, title: "Mise à jour de votre litige", body: `Statut : ${status}. ${resolution_note || ""}` });

  res.redirect(`/tontines/${req.tontine.id}/disputes`);
});

// ---------- HISTORIQUE / JOURNAL D'AUDIT ----------
router.get("/tontines/:id/history", requireAuth, loadMembership, (req, res) => {
  const contributions = db.prepare(`
    SELECT c.*, cy.cycle_number, u.first_name, u.last_name FROM contributions c
    JOIN cycles cy ON cy.id = c.cycle_id
    JOIN tontine_members tm ON tm.id = c.member_id
    JOIN users u ON u.id = tm.user_id
    WHERE cy.tontine_id = ? ORDER BY cy.cycle_number ASC, u.first_name ASC
  `).all(req.tontine.id);
  res.render("history", { contributions });
});

router.get("/tontines/:id/audit", requireAuth, loadMembership, requireRole("admin", "treasurer"), (req, res) => {
  const logs = db.prepare(`
    SELECT al.*, u.first_name, u.last_name FROM audit_logs al
    LEFT JOIN users u ON u.id = al.actor_user_id
    WHERE al.tontine_id = ? ORDER BY al.created_at DESC LIMIT 300
  `).all(req.tontine.id);
  res.render("audit", { logs });
});

// ---------- RAPPORT (imprimable en PDF via le navigateur) ----------
router.get("/tontines/:id/report", requireAuth, loadMembership, (req, res) => {
  const members = db.prepare(`
    SELECT tm.*, u.first_name, u.last_name FROM tontine_members tm JOIN users u ON u.id=tm.user_id WHERE tm.tontine_id=?
  `).all(req.tontine.id);
  const cycles = db.prepare(`
    SELECT cy.*, u.first_name as ben_first, u.last_name as ben_last FROM cycles cy
    LEFT JOIN tontine_members bm ON bm.id=cy.beneficiary_member_id LEFT JOIN users u ON u.id=bm.user_id
    WHERE cy.tontine_id=? ORDER BY cy.cycle_number ASC
  `).all(req.tontine.id);
  const contributions = db.prepare(`
    SELECT c.*, cy.cycle_number, u.first_name, u.last_name FROM contributions c
    JOIN cycles cy ON cy.id=c.cycle_id JOIN tontine_members tm ON tm.id=c.member_id JOIN users u ON u.id=tm.user_id
    WHERE cy.tontine_id=? ORDER BY cy.cycle_number ASC
  `).all(req.tontine.id);
  const disputes = db.prepare(`SELECT * FROM disputes WHERE tontine_id = ?`).all(req.tontine.id);
  const excluded = members.filter((m) => m.status === "excluded");

  res.render("report", { members, cycles, contributions, disputes, excluded, generatedAt: new Date().toLocaleString("fr-FR") });
});

module.exports = router;
