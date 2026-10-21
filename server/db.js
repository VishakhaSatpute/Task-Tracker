// SQLite persistence through libSQL. Locally it is a plain file (data/task-tracker.db);
// on Vercel set TURSO_DATABASE_URL / TURSO_AUTH_TOKEN to use a hosted Turso database.
import { createClient } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// WARBOARD_DATA_DIR is the pre-rename name of the env var; still honoured.
const dataDir = process.env.TASK_TRACKER_DATA_DIR || process.env.WARBOARD_DATA_DIR || path.join(root, "data");
const remoteUrl = process.env.TURSO_DATABASE_URL;

export const dbPath = remoteUrl || path.join(dataDir, "task-tracker.db");

if (!remoteUrl) {
  fs.mkdirSync(dataDir, { recursive: true });
  // One-time migration from the pre-rename file name. Moves the WAL/SHM sidecars
  // with it so no committed data is left behind. Never overwrites an existing new DB.
  const legacyPath = path.join(dataDir, "warboard.db");
  if (!fs.existsSync(dbPath) && fs.existsSync(legacyPath)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(legacyPath + suffix)) fs.renameSync(legacyPath + suffix, dbPath + suffix);
    }
    console.log("Migrated database warboard.db -> task-tracker.db");
  }
}

const db = createClient(
  remoteUrl
    ? { url: remoteUrl, authToken: process.env.TURSO_AUTH_TOKEN }
    : { url: "file:" + dbPath }
);

// Generic document table: path is "projects/<id>", "projects/<id>/notes/<id>",
// "types/<id>", "members/<id>", "noteFiles/<encoded name>".
const ready = (async () => {
  if (!remoteUrl) await db.execute("PRAGMA journal_mode = WAL");
  await db.batch([
    `CREATE TABLE IF NOT EXISTS docs (
       path       TEXT PRIMARY KEY,
       collection TEXT NOT NULL,
       data       TEXT NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    "CREATE INDEX IF NOT EXISTS idx_docs_collection ON docs(collection)",
    `CREATE TABLE IF NOT EXISTS settings (
       key   TEXT PRIMARY KEY,
       value TEXT NOT NULL
     )`,
  ]);
})();

async function run(sql, args = []) {
  await ready;
  return db.execute({ sql, args });
}

function collectionOf(p) {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

const UPSERT =
  "INSERT INTO docs (path, collection, data, updated_at) VALUES (?, ?, ?, ?) " +
  "ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at";
const SET_SETTING =
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";

export async function allDocs() {
  const { rows } = await run("SELECT path, data FROM docs");
  return rows.map((r) => ({ path: r.path, data: JSON.parse(r.data) }));
}

export async function setDoc(p, data) {
  await run(UPSERT, [p, collectionOf(p), JSON.stringify(data), Date.now()]);
}

export async function updateDoc(p, patch) {
  const { rows } = await run("SELECT data FROM docs WHERE path = ?", [p]);
  const current = rows[0] ? JSON.parse(rows[0].data) : {};
  const next = { ...current, ...patch };
  await setDoc(p, next);
  return next;
}

// Deletes the doc and everything beneath it (a project's notes).
export async function deleteDoc(p) {
  await run("DELETE FROM docs WHERE path = ?1 OR substr(path, 1, length(?1) + 1) = ?1 || '/'", [p]);
}

export async function getSettings() {
  const { rows } = await run("SELECT key, value FROM settings");
  const out = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}

export async function setSetting(key, value) {
  await run(SET_SETTING, [key, JSON.stringify(value)]);
}

// Single-writer sync lease, kept in the DB because serverless instances share no memory.
// The conditional upsert makes acquire atomic: it only writes when the lease is free,
// expired or already ours.
const LEASE_KEY = "_syncLease";

export async function acquireLease(owner, ttlMs) {
  const now = Date.now();
  const value = JSON.stringify({ owner, expires: now + ttlMs });
  const res = await run(
    "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value " +
    "WHERE json_extract(settings.value, '$.owner') = ?3 OR json_extract(settings.value, '$.expires') <= ?4",
    [LEASE_KEY, value, owner, now]
  );
  return res.rowsAffected > 0;
}

export async function releaseLease(owner) {
  await run("DELETE FROM settings WHERE key = ? AND json_extract(value, '$.owner') = ?", [LEASE_KEY, owner]);
}
