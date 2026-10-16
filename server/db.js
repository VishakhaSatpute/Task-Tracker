// SQLite persistence (node:sqlite, built into Node 22+). One file: data/task-tracker.db
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// WARBOARD_DATA_DIR is the pre-rename name of the env var; still honoured.
const dataDir = process.env.TASK_TRACKER_DATA_DIR || process.env.WARBOARD_DATA_DIR || path.join(root, "data");
fs.mkdirSync(dataDir, { recursive: true });

export const dbPath = path.join(dataDir, "task-tracker.db");

// One-time migration from the pre-rename file name. Moves the WAL/SHM sidecars
// with it so no committed data is left behind. Never overwrites an existing new DB.
const legacyPath = path.join(dataDir, "warboard.db");
if (!fs.existsSync(dbPath) && fs.existsSync(legacyPath)) {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(legacyPath + suffix)) fs.renameSync(legacyPath + suffix, dbPath + suffix);
  }
  console.log("Migrated database warboard.db -> task-tracker.db");
}

const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  -- Generic document table: path is "projects/<id>", "projects/<id>/notes/<id>",
  -- "types/<id>", "members/<id>", "noteFiles/<encoded name>".
  CREATE TABLE IF NOT EXISTS docs (
    path       TEXT PRIMARY KEY,
    collection TEXT NOT NULL,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_docs_collection ON docs(collection);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

function collectionOf(p) {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

const qAll = db.prepare("SELECT path, data FROM docs");
const qGet = db.prepare("SELECT data FROM docs WHERE path = ?");
const qUpsert = db.prepare(
  "INSERT INTO docs (path, collection, data, updated_at) VALUES (?, ?, ?, ?) " +
  "ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
);
const qDelete = db.prepare(
  "DELETE FROM docs WHERE path = ?1 OR substr(path, 1, length(?1) + 1) = ?1 || '/'"
);
const qSettings = db.prepare("SELECT key, value FROM settings");
const qSetSetting = db.prepare(
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);

export function allDocs() {
  return qAll.all().map((r) => ({ path: r.path, data: JSON.parse(r.data) }));
}

export function setDoc(p, data) {
  qUpsert.run(p, collectionOf(p), JSON.stringify(data), Date.now());
}

export function updateDoc(p, patch) {
  const row = qGet.get(p);
  const current = row ? JSON.parse(row.data) : {};
  const next = { ...current, ...patch };
  setDoc(p, next);
  return next;
}

// Deletes the doc and everything beneath it (a project's notes).
export function deleteDoc(p) {
  qDelete.run(p);
}

export function getSettings() {
  const out = {};
  for (const r of qSettings.all()) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}

export function setSetting(key, value) {
  qSetSetting.run(key, JSON.stringify(value));
}
