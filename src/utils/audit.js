const { v4: uuidv4 } = require("uuid");
const db = require("../db");

/**
 * Enregistre une entrée dans le journal d'audit.
 * Toute opération sensible doit passer par cette fonction (traçabilité — section 5 du cahier des charges).
 */
function logAudit({ tontineId = null, actorUserId, action, entity = null, entityId = null, oldValue = null, newValue = null }) {
  db.prepare(`
    INSERT INTO audit_logs (tontine_id, actor_user_id, action, entity, entity_id, old_value, new_value)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    tontineId,
    actorUserId,
    action,
    entity,
    entityId,
    oldValue !== null && typeof oldValue !== "string" ? JSON.stringify(oldValue) : oldValue,
    newValue !== null && typeof newValue !== "string" ? JSON.stringify(newValue) : newValue
  );
}

/**
 * Crée une notification in-app, et simule un envoi SMS (log console) pour les canaux critiques.
 * En production, le canal "sms" devrait être branché sur un fournisseur SMS/USSD réel.
 */
function notify({ userId, tontineId = null, title, body = "", channel = "in_app" }) {
  db.prepare(`
    INSERT INTO notifications (id, user_id, tontine_id, channel, title, body)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), userId, tontineId, channel, title, body);

  if (channel === "sms") {
    // Simulation d'envoi SMS de secours (à remplacer par un vrai fournisseur en production)
    console.log(`[SMS SIMULÉ] -> user ${userId}: ${title} — ${body}`);
  }
}

function notifyBothChannels(args) {
  notify({ ...args, channel: "in_app" });
  notify({ ...args, channel: "sms" });
}

module.exports = { logAudit, notify, notifyBothChannels };
