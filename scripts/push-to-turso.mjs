// Standalone, dependency-free copy of a Task Tracker SQLite database into Turso.
// Needs Node 22+ only (node:sqlite + fetch); no npm install.
//
//   export TURSO_DATABASE_URL=libsql://<db>.turso.io
//   export TURSO_AUTH_TOKEN=...
//   node push-to-turso.mjs [path/to/task-tracker.db] [--dry-run] [--with-keys]
//
// Source: first argument, else $TASK_TRACKER_DATA_DIR/task-tracker.db, else ./data/task-tracker.db.
// Saved API keys are skipped unless --with-keys. Safe to re-run (rows are upserted).
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const withKeys = args.includes("--with-keys");
const given = args.find((a) => !a.startsWith("--"));

const dataDir = process.env.TASK_TRACKER_DATA_DIR || process.env.WARBOARD_DATA_DIR || path.resolve("data");
const candidates = given ? [given] : [path.join(dataDir, "task-tracker.db"), path.join(dataDir, "warboard.db")];
const source = candidates.find((p) => fs.existsSync(p));
if (!source) { console.error("Database not found. Tried:\n  " + candidates.join("\n  ")); process.exit(1); }

const db = new DatabaseSync(source, { readOnly: true });
const docs = db.prepare("SELECT path, collection, data, updated_at FROM docs").all();
const settings = db.prepare("SELECT key, value FROM settings").all()
  .filter((r) => r.key !== "_syncLease" && (withKeys || !/apiKey$/i.test(r.key)));
console.log(`Source: ${path.resolve(source)}\n  ${docs.length} docs, ${settings.length} settings to copy`);

if (docs.length === 0) {
  console.error("No docs in this database, nothing to migrate. Wrong data folder? (a -wal file next to the .db must be kept with it)");
  process.exit(1);
}
if (dryRun) { console.log("--dry-run: nothing sent."); process.exit(0); }

const base = (process.env.TURSO_DATABASE_URL || "").replace(/^libsql:\/\//, "https://").replace(/\/+$/, "");
const token = process.env.TURSO_AUTH_TOKEN;
if (!base || !token) { console.error("Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN first."); process.exit(1); }

const val = (v) => (typeof v === "number" ? { type: "integer", value: String(v) } : { type: "text", value: String(v) });
const stmt = (sql, a = []) => ({ type: "execute", stmt: { sql, args: a.map(val) } });

// One pipeline request = one connection, so BEGIN..COMMIT inside it is a real transaction.
async function pipeline(statements) {
  const res = await fetch(base + "/v2/pipeline", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ requests: [...statements, { type: "close" }] }),
  });
  if (!res.ok) throw new Error(`Turso returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const failed = body.results.find((r) => r.type === "error");
  if (failed) throw new Error("Turso error: " + (failed.error?.message || JSON.stringify(failed)));
  return body.results;
}

await pipeline([
  stmt("CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, collection TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)"),
  stmt("CREATE INDEX IF NOT EXISTS idx_docs_collection ON docs(collection)"),
  stmt("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"),
]);

const UPSERT_DOC =
  "INSERT INTO docs (path, collection, data, updated_at) VALUES (?, ?, ?, ?) " +
  "ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at";
const UPSERT_SETTING = "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";

const rows = [
  ...docs.map((r) => stmt(UPSERT_DOC, [r.path, r.collection, r.data, r.updated_at])),
  ...settings.map((r) => stmt(UPSERT_SETTING, [r.key, r.value])),
];
const BATCH = 100;
for (let i = 0; i < rows.length; i += BATCH) {
  await pipeline([stmt("BEGIN"), ...rows.slice(i, i + BATCH), stmt("COMMIT")]);
  console.log(`  sent ${Math.min(i + BATCH, rows.length)} / ${rows.length}`);
}

const [, , d, s] = (await pipeline([
  stmt("SELECT 1"),
  stmt("SELECT 1"),
  stmt("SELECT count(*) FROM docs"),
  stmt("SELECT count(*) FROM settings"),
])).map((r) => r.response?.result?.rows?.[0]?.[0]?.value);
console.log(`Turso now has ${d} docs and ${s} settings (source had ${docs.length} docs).`);
