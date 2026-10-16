// Settings live in the server's SQLite database. The API key is write-only
// from the browser: the server only reports whether one is set.

export const DEFAULT_SETTINGS = {
  provider: "anthropic",
  hasApiKey: false, // true when the active provider has a key
  hasAnthropicKey: false,
  hasOpenaiKey: false,
  anthropicModel: "claude-sonnet-5-5",
  openaiModel: "gpt-4o-mini",
  lastSyncAt: 0,
};

export async function loadSettings() {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error("settings load failed");
  return { ...DEFAULT_SETTINGS, ...(await res.json()) };
}

// `patch` may include provider, apiKey (Anthropic), openaiApiKey, clearKey,
// anthropicModel, openaiModel, lastSyncAt.
export async function saveSettings(patch) {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("settings save failed");
  return { ...DEFAULT_SETTINGS, ...(await res.json()) };
}
