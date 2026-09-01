const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { logAudit, notifyBothChannels } = require("./audit");

function addInterval(dateStr, frequency, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  if (frequency === "weekly") d.setUTCDate(d.getUTCDate() + 7 * n);
  else d.setUTCMonth(d.getUTCMonth() + n); // monthly
  return d.toISOString().slice(0, 10);
}

/**
 * Génère les cycles d'une tontine (appelé une seule fois, à la création ou après le premier tirage).
 * Le montant attendu par cycle = montant de cotisation x nombre de membres actifs au moment de la génération.
 */
function generateCycles(tontine, activeMembersCount) {
  const cycles = [];
  for (let i = 1; i <= tontine.num_cycles; i++) {
    const start = addInterval(tontine.start_date, tontine.frequency, i - 1);
    const due = addInterval(start, tontine.frequency, 1);
    cycles.push({
      id: uuidv4(),
      tontine_id: tontine.id,
      cycle_number: i,
      start_date: start,
      due_date: due,
      beneficiary_member_id: null,
      expected_amount: tontine.amount * activeMembersCount,
      collected_amount: 0,
      status: "open",
    });
  }
  const insert = db.prepare(`
    INSERT INTO cycles (id, tontine_id, cycle_number, start_date, due_date, beneficiary_member_id, expected_amount, collected_amount, status)
    VALUES (@id, @tontine_id, @cycle_number, @start_date, @due_date, @beneficiary_member_id, @expected_amount, @collected_amount, @status)
  `);
  const insertMany = db.transaction((rows) => rows.forEach((r) => insert.run(r)));
  insertMany(cycles);

  // Une cotisation "attendue" par membre actif, pour chaque cycle
  const members = db.prepare(`SELECT id FROM tontine_members WHERE tontine_id = ? AND status = 'active'`).all(tontine.id);
  const insertContrib = db.prepare(`
    INSERT INTO contributions (id, cycle_id, member_id, expected_amount, status)
    VALUES (?, ?, ?, ?, 'pending')
  `);
  const insertContribs = db.transaction(() => {
    cycles.forEach((c) => {
      members.forEach((m) => {
        insertContrib.run(uuidv4(), c.id, m.id, tontine.amount);
      });
    });
  });
  insertContribs();

  return cycles;
}

/**
 * Vérifie les échéances dépassées et met à jour les statuts (retard -> défaut) + relances graduées.
 * Appelée à chaque chargement du tableau de bord / du détail d'une tontine (à défaut d'un vrai job planifié).
 */
function runArrearsCheck(tontineId) {
  const today = new Date().toISOString().slice(0, 10);

  const overdueContribs = db.prepare(`
    SELECT c.*, cy.due_date, cy.tontine_id, tm.status as member_status, tm.user_id
    FROM contributions c
    JOIN cycles cy ON cy.id = c.cycle_id
    JOIN tontine_members tm ON tm.id = c.member_id
    WHERE cy.tontine_id = ? AND c.status = 'pending' AND cy.due_date < ?
  `).all(tontineId, today);

  for (const c of overdueContribs) {
    db.prepare(`UPDATE contributions SET status = 'late' WHERE id = ?`).run(c.id);
    logAudit({
      tontineId,
      actorUserId: "system",
      action: "contribution_marked_late",
      entity: "contribution",
      entityId: c.id,
      oldValue: "pending",
      newValue: "late",
    });

    const daysLate = Math.floor((new Date(today) - new Date(c.due_date)) / (1000 * 60 * 60 * 24));
    if ([1, 3, 7].includes(daysLate)) {
      notifyBothChannels({
        userId: c.user_id,
        tontineId,
        title: `Cotisation en retard (J+${daysLate})`,
        body: `Votre cotisation attendue le ${c.due_date} n'a pas encore été enregistrée. Merci de régulariser.`,
      });
    }
    // Retard chronique (3 cotisations en retard) -> statut "en défaut"
    if (daysLate >= 7 && c.member_status === "active") {
      const lateCount = db.prepare(`
        SELECT COUNT(*) as n FROM contributions co
        JOIN cycles cy2 ON cy2.id = co.cycle_id
        WHERE co.member_id = ? AND co.status = 'late'
      `).get(c.member_id).n;
      if (lateCount >= 3) {
        db.prepare(`UPDATE tontine_members SET status = 'default' WHERE id = ?`).run(c.member_id);
        logAudit({
          tontineId,
          actorUserId: "system",
          action: "member_status_default",
          entity: "tontine_member",
          entityId: c.member_id,
          oldValue: "active",
          newValue: "default",
        });
      } else {
        db.prepare(`UPDATE tontine_members SET status = 'late' WHERE id = ? AND status = 'active'`).run(c.member_id);
      }
    }
  }
}

module.exports = { generateCycles, runArrearsCheck, addInterval };
