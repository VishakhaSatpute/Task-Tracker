import express from "express";
import * as store from "./db.js";

const PORT = Number(process.env.PORT || 3001);
const PROVIDERS = ["anthropic", "openai"];
const ANTHROPIC_MODEL = "claude-sonnet-5-5";
const OPENAI_MODEL = "gpt-4o-mini";
// Overridable so tests can point at a local stub instead of the real APIs.
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
const OPENAI_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com";
const DEFAULTS = { provider: "anthropic", lastSyncAt: 0 };

const app = express();
app.use(express.json({ limit: "1mb" }));

// Bound to localhost only (see listen below), but also refuse cross-site browser writes.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return res.status(403).json({ error: "forbidden origin" });
  }
  next();
});

const validPath = (p) => typeof p === "string" && p.length > 0 && p.length < 512 && !p.startsWith("/") && !p.includes("//");

app.get("/api/docs", (_req, res) => res.json(store.allDocs()));

app.post("/api/docs/set", (req, res) => {
  const { path, data } = req.body || {};
  if (!validPath(path) || typeof data !== "object" || data === null) return res.status(400).json({ error: "bad request" });
  store.setDoc(path, data);
  res.json({ ok: true });
});

app.post("/api/docs/update", (req, res) => {
  const { path, data } = req.body || {};
  if (!validPath(path) || typeof data !== "object" || data === null) return res.status(400).json({ error: "bad request" });
  res.json({ ok: true, data: store.updateDoc(path, data) });
});

app.post("/api/docs/delete", (req, res) => {
  const { path } = req.body || {};
  if (!validPath(path)) return res.status(400).json({ error: "bad request" });
  store.deleteDoc(path);
  res.json({ ok: true });
});

// API keys never leave the server: the client only learns whether one is set.
function activeKey(s, provider) {
  return provider === "openai"
    ? s.openaiApiKey || process.env.OPENAI_API_KEY || ""
    : s.apiKey || process.env.ANTHROPIC_API_KEY || "";
}

function publicSettings() {
  const s = { ...DEFAULTS, ...store.getSettings() };
  const provider = PROVIDERS.includes(s.provider) ? s.provider : "anthropic";
  const hasAnthropicKey = Boolean(activeKey(s, "anthropic"));
  const hasOpenaiKey = Boolean(activeKey(s, "openai"));
  return {
    provider,
    hasAnthropicKey,
    hasOpenaiKey,
    hasApiKey: provider === "openai" ? hasOpenaiKey : hasAnthropicKey,
    anthropicModel: s.anthropicModel || ANTHROPIC_MODEL,
    openaiModel: s.openaiModel || OPENAI_MODEL,
    lastSyncAt: s.lastSyncAt,
  };
}

app.get("/api/settings", (_req, res) => res.json(publicSettings()));

const modelOk = (m) => typeof m === "string" && /^[\w.:\-/]{1,100}$/.test(m.trim());

app.put("/api/settings", (req, res) => {
  const b = req.body || {};
  if (b.provider !== undefined) {
    if (!PROVIDERS.includes(b.provider)) return res.status(400).json({ error: "unknown provider" });
    store.setSetting("provider", b.provider);
  }
  // A blank key means "unchanged"; removing a key is an explicit clearKey.
  if (typeof b.apiKey === "string" && b.apiKey.trim()) store.setSetting("apiKey", b.apiKey.trim());
  if (typeof b.openaiApiKey === "string" && b.openaiApiKey.trim()) store.setSetting("openaiApiKey", b.openaiApiKey.trim());
  if (b.clearKey !== undefined) {
    if (!PROVIDERS.includes(b.clearKey)) return res.status(400).json({ error: "unknown provider" });
    store.setSetting(b.clearKey === "openai" ? "openaiApiKey" : "apiKey", "");
  }
  if (typeof b.anthropicModel === "string") {
    if (b.anthropicModel.trim() && !modelOk(b.anthropicModel)) return res.status(400).json({ error: "bad model name" });
    store.setSetting("anthropicModel", b.anthropicModel.trim());
  }
  if (typeof b.openaiModel === "string") {
    if (b.openaiModel.trim() && !modelOk(b.openaiModel)) return res.status(400).json({ error: "bad model name" });
    store.setSetting("openaiModel", b.openaiModel.trim());
  }
  if (typeof b.lastSyncAt === "number") store.setSetting("lastSyncAt", b.lastSyncAt);
  res.json(publicSettings());
});

function errorCode(status) {
  if (status === 401 || status === 403) return "auth_error";
  if (status === 429) return "rate_limited";
  if (status === 413) return "prompt_too_large";
  return "upstream_error";
}

class LlmError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function callAnthropic(prompt, apiKey, model) {
  let r;
  try {
    r = await fetch(ANTHROPIC_BASE + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: "user", content: prompt }] }),
    });
  } catch {
    throw new LlmError("network_error", "Could not reach the Anthropic API");
  }
  if (!r.ok) throw new LlmError(errorCode(r.status), "Anthropic API returned " + r.status);
  const body = await r.json();
  return (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

async function callOpenAI(prompt, apiKey, model) {
  let r;
  try {
    r = await fetch(OPENAI_BASE + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    throw new LlmError("network_error", "Could not reach the OpenAI API");
  }
  if (!r.ok) throw new LlmError(errorCode(r.status), "OpenAI API returned " + r.status);
  const body = await r.json();
  return body?.choices?.[0]?.message?.content || "";
}

// Sends one prompt to the active provider; returns { text }.
async function handleLlm(req, res) {
  const { prompt } = req.body || {};
  if (typeof prompt !== "string" || !prompt) return res.status(400).json({ error: "bad request" });
  const settings = store.getSettings();
  const provider = PROVIDERS.includes(settings.provider) ? settings.provider : "anthropic";
  const apiKey = activeKey(settings, provider);
  const label = provider === "openai" ? "OpenAI" : "Anthropic";
  if (!apiKey) return res.status(400).json({ code: "no_api_key", provider, error: "No " + label + " API key set" });
  try {
    const text = provider === "openai"
      ? await callOpenAI(prompt, apiKey, settings.openaiModel || OPENAI_MODEL)
      : await callAnthropic(prompt, apiKey, settings.anthropicModel || ANTHROPIC_MODEL);
    res.json({ text, provider });
  } catch (e) {
    res.status(502).json({ code: e.code || "upstream_error", provider, error: e.message || "Request failed" });
  }
}

app.post("/api/llm", handleLlm);
app.post("/api/claude", handleLlm); // legacy alias

// Single-writer lease for note syncs, so two tabs/windows can't process the same
// files at once. In memory on purpose: it auto-expires and a server restart clears it.
const LEASE_MS = 10 * 60 * 1000;
let lease = null; // { owner, expires }

app.post("/api/sync/acquire", (req, res) => {
  const owner = req.body && req.body.owner;
  if (typeof owner !== "string" || !owner || owner.length > 100) return res.status(400).json({ error: "bad request" });
  const now = Date.now();
  if (lease && lease.expires > now && lease.owner !== owner) {
    return res.status(409).json({ code: "sync_in_progress", error: "A sync is already running in another tab or window." });
  }
  lease = { owner, expires: now + LEASE_MS }; // same owner = renew
  res.json({ ok: true });
});

app.post("/api/sync/release", (req, res) => {
  const owner = req.body && req.body.owner;
  if (lease && lease.owner === owner) lease = null;
  res.json({ ok: true });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log("Task Tracker API on http://127.0.0.1:" + PORT + "  (db: " + store.dbPath + ")");
});
