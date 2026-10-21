// One-time copy of the local database (data/task-tracker.db) into Turso.
// Usage: TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/migrate-to-turso.js [--with-keys]
// API keys saved in Settings are skipped unless --with-keys is passed; prefer Vercel env vars.
import { createClient } from "@libsql/client";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localPath = process.env.TASK_TRACKER_DATA_DIR
  ? path.join(process.env.TASK_TRACKER_DATA_DIR, "task-tracker.db")
  : path.join(root, "data", "task-tracker.db");

if (!process.env.TURSO_DATABASE_URL) {
  console.error("Set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN) first.");
  process.exit(1);
}
const withKeys = process.argv.includes("--with-keys");

const local = createClient({ url: "file:" + localPath });
const remote = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

await remote.batch([
  "CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, collection TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_docs_collection ON docs(collection)",
  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
]);

const docs = (await local.execute("SELECT path, collection, data, updated_at FROM docs")).rows;
const settings = (await local.execute("SELECT key, value FROM settings")).rows
  .filter((r) => r.key !== "_syncLease" && (withKeys || !/apiKey$/i.test(r.key)));

await remote.batch([
  ...docs.map((r) => ({
    sql: "INSERT INTO docs (path, collection, data, updated_at) VALUES (?, ?, ?, ?) " +
         "ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
    args: [r.path, r.collection, r.data, r.updated_at],
  })),
  ...settings.map((r) => ({
    sql: "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [r.key, r.value],
  })),
]);
console.log(`Copied ${docs.length} docs and ${settings.length} settings.`);
