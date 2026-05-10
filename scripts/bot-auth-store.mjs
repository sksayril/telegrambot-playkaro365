/**
 * Persistence via sql.js (WebAssembly SQLite) — no native Node addons, works on Node 20+
 * and ignores NODE_MODULE_VERSION mismatches from better-sqlite3.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const dataDir = join(projectRoot, "data");
mkdirSync(dataDir, { recursive: true });

/** Same filename as before so an existing SQLite file keeps working when opened here. */
const dbPath = join(dataDir, "telegram_bot.sqlite");

const SQL = await initSqlJs();

/** @type {import("sql.js").Database | null} */
let db = null;

function persist() {
  if (!db) return;
  writeFileSync(dbPath, Buffer.from(db.export()));
}

function ensureDb() {
  if (db) return db;
  if (existsSync(dbPath)) {
    const buf = readFileSync(dbPath);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  telegram_user_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE TABLE IF NOT EXISTS admins (
  telegram_user_id INTEGER PRIMARY KEY,
  added_by INTEGER,
  created_at TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS blocked_users (
  telegram_user_id INTEGER PRIMARY KEY,
  blocked_by INTEGER,
  blocked_at TEXT NOT NULL,
  reason TEXT
);
CREATE TABLE IF NOT EXISTS joinpromo_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  site TEXT NOT NULL,
  identifier TEXT NOT NULL,
  password TEXT NOT NULL,
  amount TEXT NOT NULL,
  promotion_id TEXT NOT NULL,
  proxy TEXT,
  join_url TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_joinpromo_requests_created_at ON joinpromo_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_joinpromo_requests_user_id ON joinpromo_requests(telegram_user_id);
`);
  persist();
  return db;
}

/** @typedef {'pending' | 'approved' | 'rejected'} UserStatus */

/**
 * Owner from env — always seeded as admin + auto-approved user row.
 */
export function bootstrapOwner(ownerTelegramId) {
  ensureDb();
  if (!ownerTelegramId || !Number.isFinite(ownerTelegramId)) return;
  const now = new Date().toISOString();

  db.run(`DELETE FROM blocked_users WHERE telegram_user_id = ?`, [ownerTelegramId]);

  db.run(`INSERT OR IGNORE INTO admins (telegram_user_id, added_by, created_at, is_owner)
          VALUES (?, NULL, ?, 1)`, [ownerTelegramId, now]);
  db.run(`UPDATE admins SET is_owner = 1 WHERE telegram_user_id = ?`, [ownerTelegramId]);

  const u = db.exec(`SELECT telegram_user_id FROM users WHERE telegram_user_id = ${ownerTelegramId}`);
  if (!u?.[0]?.values?.length) {
    db.run(
      `INSERT INTO users (telegram_user_id, username, first_name, last_name, status, created_at, updated_at)
       VALUES (?, '', '', '', 'approved', ?, ?)`,
      [ownerTelegramId, now, now]
    );
  } else {
    db.run(
      `UPDATE users SET status = 'approved', updated_at = ?
       WHERE telegram_user_id = ? AND status != 'rejected'`,
      [now, ownerTelegramId]
    );
  }
  persist();
}

/** @returns {boolean} */
export function isAdmin(telegramUserId) {
  ensureDb();
  const r = db.exec(`SELECT 1 FROM admins WHERE telegram_user_id = ${Number(telegramUserId)}`);
  return Boolean(r?.[0]?.values?.length);
}

/** @returns {boolean} */
export function isOwnerFlag(telegramUserId) {
  ensureDb();
  const r = db.exec(
    `SELECT is_owner FROM admins WHERE telegram_user_id = ${Number(
      telegramUserId
    )} AND is_owner = 1`
  );
  return Boolean(r?.[0]?.values?.length);
}

/** @returns {boolean} */
export function isBlocked(telegramUserId) {
  ensureDb();
  const uid = Number(telegramUserId);
  if (!Number.isFinite(uid)) return false;
  const r = db.exec(`SELECT 1 FROM blocked_users WHERE telegram_user_id = ${uid}`);
  return Boolean(r?.[0]?.values?.length);
}

/**
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function blockUser(targetId, actingAdminId, reason = "") {
  ensureDb();
  if (!Number.isFinite(targetId)) return { ok: false, error: "Bad user id" };
  if (!isAdmin(actingAdminId)) return { ok: false, error: "Not admin" };
  const envOwner = Number.parseInt(String(process.env.TELEGRAM_OWNER_ID || "").trim(), 10);
  if (Number.isFinite(envOwner) && targetId === envOwner) {
    return { ok: false, error: "Cannot block bot owner" };
  }

  const now = new Date().toISOString();
  const rs = reason && String(reason).trim() ? String(reason).trim() : null;
  db.run(`INSERT OR REPLACE INTO blocked_users (telegram_user_id, blocked_by, blocked_at, reason)
          VALUES (?, ?, ?, ?)`, [targetId, actingAdminId, now, rs]);
  persist();
  return { ok: true };
}

/**
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function unblockUser(targetId, actingAdminId) {
  ensureDb();
  if (!Number.isFinite(targetId)) return { ok: false, error: "Bad user id" };
  if (!isAdmin(actingAdminId)) return { ok: false, error: "Not admin" };
  const check = db.exec(`SELECT 1 FROM blocked_users WHERE telegram_user_id = ${Number(targetId)}`);
  if (!check?.[0]?.values?.length) return { ok: false, error: "User was not blocked" };
  db.run(`DELETE FROM blocked_users WHERE telegram_user_id = ?`, [targetId]);
  persist();
  return { ok: true };
}

export function listBlockedUsers(limit = 40) {
  ensureDb();
  const stmt = db.prepare(
    `SELECT telegram_user_id, blocked_by, blocked_at, reason FROM blocked_users ORDER BY blocked_at DESC LIMIT ?`
  );
  stmt.bind([limit]);
  const out = [];
  while (stmt.step()) {
    out.push(stmt.getAsObject());
  }
  stmt.free();
  return out;
}

export function listApprovedUsersDetailed(limit = 50) {
  ensureDb();
  const stmt = db.prepare(
    `SELECT telegram_user_id, username, first_name, last_name, status, created_at, updated_at
     FROM users
     WHERE status = 'approved'
     ORDER BY updated_at DESC
     LIMIT ?`
  );
  stmt.bind([limit]);
  const out = [];
  while (stmt.step()) {
    out.push(stmt.getAsObject());
  }
  stmt.free();
  return out;
}

/**
 * Stores raw /joinpromo input for admin auditing.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function logJoinPromoRequest(from, parsed) {
  ensureDb();
  const uid = Number(from?.id);
  if (!Number.isFinite(uid)) return { ok: false, error: "Bad Telegram user id" };
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "Bad parsed payload" };

  const site = String(parsed.site || "").trim();
  const identifier = String(parsed.identifier || "").trim();
  const password = String(parsed.password || "").trim();
  const amount = String(parsed.amount || "").trim();
  const promotionId = String(parsed.promotionId || "").trim() || "22";
  const proxy = String(parsed.proxy || "").trim() || null;
  const joinUrl = String(parsed.joinUrl || "").trim() || null;
  if (!site || !identifier || !password || !amount) {
    return { ok: false, error: "Missing required joinpromo fields" };
  }

  const username = String(from?.username || "").trim() || null;
  const firstName = String(from?.first_name || "").trim() || null;
  const lastName = String(from?.last_name || "").trim() || null;
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO joinpromo_requests (
      telegram_user_id, username, first_name, last_name,
      site, identifier, password, amount, promotion_id, proxy, join_url, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uid,
      username,
      firstName,
      lastName,
      site,
      identifier,
      password,
      amount,
      promotionId,
      proxy,
      joinUrl,
      now,
    ]
  );
  persist();
  return { ok: true };
}

export function listJoinPromoRequests(limit = 50) {
  ensureDb();
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const stmt = db.prepare(
    `SELECT id, telegram_user_id, username, first_name, last_name,
            site, identifier, password, amount, promotion_id, proxy, join_url, created_at
     FROM joinpromo_requests
     ORDER BY id DESC
     LIMIT ?`
  );
  stmt.bind([safeLimit]);
  const out = [];
  while (stmt.step()) {
    out.push(stmt.getAsObject());
  }
  stmt.free();
  return out;
}

/**
 * Upsert Telegram user profile fields; inserts new rows as pending.
 * @returns {{ status: UserStatus, isNew: boolean }}
 */
export function touchUserFromTelegram(from) {
  ensureDb();
  const id = from?.id;
  if (!Number.isFinite(id)) return { status: "pending", isNew: false };

  const username = String(from.username || "").trim() || null;
  const first_name = String(from.first_name || "").trim() || "";
  const last_name = String(from.last_name || "").trim() || "";
  const now = new Date().toISOString();

  const existing = db.exec(`SELECT telegram_user_id, status FROM users WHERE telegram_user_id = ${id}`);
  /** @type {{ status: UserStatus, isNew: boolean }} */
  let out;

  if (!existing?.[0]?.values?.length) {
    db.run(
      `INSERT INTO users (telegram_user_id, username, first_name, last_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [id, username, first_name, last_name, now, now]
    );
    out = { status: "pending", isNew: true };
  } else {
    const st = existing[0].values[0][1];
    db.run(
      `UPDATE users SET username = ?, first_name = ?, last_name = ?, updated_at = ? WHERE telegram_user_id = ?`,
      [username, first_name, last_name, now, id]
    );
    out = { status: /** @type {UserStatus} */ (st), isNew: false };
  }
  persist();
  return out;
}

/** @returns {UserStatus | null} */
export function getUserStatus(telegramUserId) {
  ensureDb();
  const uid = Number(telegramUserId);
  const r = db.exec(`SELECT status FROM users WHERE telegram_user_id = ${uid}`);
  const v = r?.[0]?.values?.[0]?.[0];
  return typeof v === "string" ? /** @type {UserStatus} */ (v) : null;
}

/** @returns {{ ok: true } | { ok: false, error: string }} */
export function setUserStatus(targetId, /** @type {UserStatus} */ status, actingAdminId) {
  ensureDb();
  if (!["pending", "approved", "rejected"].includes(status)) return { ok: false, error: "Bad status" };
  if (!isAdmin(actingAdminId)) return { ok: false, error: "Not admin" };
  if (!Number.isFinite(targetId)) return { ok: false, error: "Bad user id" };
  const envOwner = Number.parseInt(String(process.env.TELEGRAM_OWNER_ID || "").trim(), 10);
  if (Number.isFinite(envOwner) && targetId === envOwner && status !== "approved") {
    return { ok: false, error: "Cannot change bot owner access" };
  }

  const r = db.exec(`SELECT telegram_user_id FROM users WHERE telegram_user_id = ${targetId}`);
  if (!r?.[0]?.values?.length) return { ok: false, error: "User not registered" };

  const now = new Date().toISOString();
  db.run(`UPDATE users SET status = ?, updated_at = ? WHERE telegram_user_id = ?`, [status, now, targetId]);
  persist();
  return { ok: true };
}

export function listPendingUsers(limit = 30) {
  ensureDb();
  const stmt = db.prepare(
    `SELECT telegram_user_id, username, first_name, last_name, status, created_at FROM users WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`
  );
  stmt.bind([limit]);
  const out = [];
  while (stmt.step()) {
    out.push(stmt.getAsObject());
  }
  stmt.free();
  return out;
}

export function listAdminsDetailed() {
  ensureDb();
  const stmt = db.prepare(
    `SELECT telegram_user_id, added_by, created_at, is_owner FROM admins ORDER BY is_owner DESC, created_at ASC`
  );
  const out = [];
  while (stmt.step()) {
    out.push(stmt.getAsObject());
  }
  stmt.free();
  return out;
}

export function getApprovedUserIds() {
  ensureDb();
  const r = db.exec(`
    SELECT u.telegram_user_id
    FROM users u
    WHERE u.status = 'approved'
      AND NOT EXISTS (
        SELECT 1 FROM blocked_users b WHERE b.telegram_user_id = u.telegram_user_id
      )
  `);
  const vals = r?.[0]?.values;
  return vals ? vals.map((row) => row[0]) : [];
}

export function notifyAdminIds() {
  ensureDb();
  const r = db.exec(`SELECT telegram_user_id FROM admins`);
  const vals = r?.[0]?.values;
  return vals ? vals.map((row) => row[0]) : [];
}

/** @returns {{ ok: true } | { ok: false, error: string }} */
export function addAdministrator(newAdminId, addedByAdminId) {
  ensureDb();
  if (!Number.isFinite(newAdminId)) return { ok: false, error: "Invalid Telegram user ID" };
  if (!isAdmin(addedByAdminId)) return { ok: false, error: "Not admin" };

  const now = new Date().toISOString();
  try {
    db.run(`INSERT INTO admins (telegram_user_id, added_by, created_at, is_owner) VALUES (?, ?, ?, 0)`, [
      newAdminId,
      addedByAdminId,
      now,
    ]);
  } catch (e) {
    const msg = String(e?.message || e);
    if (/UNIQUE|constraint/i.test(msg)) return { ok: false, error: "Already admin" };
    throw e;
  }

  db.run(
    `INSERT INTO users (telegram_user_id, username, first_name, last_name, status, created_at, updated_at)
     VALUES (?, '', '', '', 'approved', ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET status = 'approved', updated_at = excluded.updated_at`,
    [newAdminId, now, now]
  );
  persist();
  return { ok: true };
}

/** @returns {{ ok: true } | { ok: false, error: string }} */
export function removeAdministrator(targetAdminId, actingAdminId, envOwnerId) {
  ensureDb();
  if (!Number.isFinite(targetAdminId)) return { ok: false, error: "Invalid ID" };
  if (!isAdmin(actingAdminId)) return { ok: false, error: "Not admin" };

  const stmt = db.prepare(`SELECT is_owner FROM admins WHERE telegram_user_id = ?`);
  stmt.bind([targetAdminId]);
  if (!stmt.step()) {
    stmt.free();
    return { ok: false, error: "Not an admin" };
  }
  const row = stmt.getAsObject();
  stmt.free();
  if (row.is_owner === 1 || targetAdminId === envOwnerId)
    return { ok: false, error: "Cannot remove bot owner" };
  db.run(`DELETE FROM admins WHERE telegram_user_id = ?`, [targetAdminId]);
  persist();
  return { ok: true };
}

export function dbPathResolved() {
  return dbPath;
}
