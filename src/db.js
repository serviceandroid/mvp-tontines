const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "tontines.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tontines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'FCFA',
  frequency TEXT NOT NULL, -- weekly | monthly
  start_date TEXT NOT NULL,
  num_cycles INTEGER NOT NULL,
  max_members INTEGER NOT NULL,
  rotation_mode TEXT NOT NULL, -- fixed_order | random_draw
  proof_threshold REAL DEFAULT 0,
  double_validation INTEGER DEFAULT 0,
  rules TEXT,
  invite_code TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'active', -- active | completed | archived
  created_by TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS tontine_members (
  id TEXT PRIMARY KEY,
  tontine_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', -- admin | treasurer | member
  status TEXT NOT NULL DEFAULT 'active', -- active | late | default | excluded | suspended
  joined_at TEXT DEFAULT (datetime('now')),
  exclusion_reason TEXT,
  UNIQUE(tontine_id, user_id),
  FOREIGN KEY (tontine_id) REFERENCES tontines(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS cycles (
  id TEXT PRIMARY KEY,
  tontine_id TEXT NOT NULL,
  cycle_number INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  beneficiary_member_id TEXT,
  expected_amount REAL NOT NULL,
  collected_amount REAL DEFAULT 0,
  status TEXT DEFAULT 'open', -- open | collecting | ready_for_payout | payout_confirmed_admin | payout_confirmed_treasurer | closed
  payout_confirmed_admin_at TEXT,
  payout_confirmed_treasurer_at TEXT,
  FOREIGN KEY (tontine_id) REFERENCES tontines(id),
  FOREIGN KEY (beneficiary_member_id) REFERENCES tontine_members(id)
);

CREATE TABLE IF NOT EXISTS draws (
  id TEXT PRIMARY KEY,
  tontine_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  drawn_by TEXT NOT NULL,
  drawn_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tontine_id) REFERENCES tontines(id)
);

CREATE TABLE IF NOT EXISTS contributions (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  expected_amount REAL NOT NULL,
  paid_amount REAL DEFAULT 0,
  payment_date TEXT,
  payment_method TEXT, -- especes | mobile_money | virement | autre
  proof_path TEXT,
  status TEXT DEFAULT 'pending', -- pending | paid | late | disputed
  validated_by TEXT,
  validated_at TEXT,
  FOREIGN KEY (cycle_id) REFERENCES cycles(id),
  FOREIGN KEY (member_id) REFERENCES tontine_members(id)
);

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  tontine_id TEXT NOT NULL,
  raised_by TEXT NOT NULL,
  contribution_id TEXT,
  cycle_id TEXT,
  subject TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'open', -- open | in_progress | resolved | rejected
  resolution_note TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tontine_id) REFERENCES tontines(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tontine_id TEXT,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tontine_id TEXT,
  channel TEXT DEFAULT 'in_app', -- in_app | sms
  title TEXT NOT NULL,
  body TEXT,
  read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

module.exports = db;
