import React, { useEffect, useState } from "react";

export function SettingsModal({ settings, folderName, folderSupported, onPickFolder, onSave, onClose }) {
  const [provider, setProvider] = useState(settings.provider || "anthropic");
  const [apiKey, setApiKey] = useState(""); // key for the selected provider
  const [anthropicModel, setAnthropicModel] = useState(settings.anthropicModel || "");
  const [openaiModel, setOpenaiModel] = useState(settings.openaiModel || "");
  const [clearKey, setClearKey] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const keySaved = provider === "openai" ? settings.hasOpenaiKey : settings.hasAnthropicKey;

  async function handleSubmit(e) {
    e.preventDefault();
    const patch = { provider, anthropicModel, openaiModel };
    const keyField = provider === "openai" ? "openaiApiKey" : "apiKey";
    if (apiKey.trim()) patch[keyField] = apiKey.trim(); // blank keeps the saved key
    else if (clearKey) patch.clearKey = provider;
    try {
      await onSave(patch);
      onClose();
    } catch (err) {
      setSaveError("Could not save settings. Is the server running?");
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <form onSubmit={handleSubmit} className="form">
          <div>
            <span className="lbl">Notes folder</span>
            {folderSupported ? (
              <div className="tm-add" style={{ marginTop: 0 }}>
                <input className="field" readOnly value={folderName || "No folder selected"} aria-label="Notes folder" />
                <button type="button" className="btn-soft" onClick={onPickFolder}>
                  {folderName ? "Change" : "Choose folder"}
                </button>
              </div>
            ) : (
              <p className="err">Folder access isn&rsquo;t supported in this browser. Use Chrome or Edge.</p>
            )}
            <p className="hint">Every <code>.txt</code> file is scanned for the projects it discusses (one file can produce several). Each file is processed once; if you edit it later, its projects are refreshed.</p>
          </div>

          <div>
            <label className="lbl" htmlFor="st-provider">AI provider</label>
            <select
              id="st-provider"
              className="field"
              value={provider}
              onChange={(e) => { setProvider(e.target.value); setApiKey(""); setClearKey(false); }}
            >
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI</option>
            </select>
          </div>

          <div>
            <label className="lbl" htmlFor="st-key">{provider === "openai" ? "OpenAI API key" : "Anthropic API key"}</label>
            <input
              id="st-key"
              type="password"
              className="field"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setClearKey(false); }}
              placeholder={keySaved ? "Key saved \u2014 type to replace" : provider === "openai" ? "sk-\u2026" : "sk-ant-\u2026"}
              autoComplete="off"
            />
            <div className="lbl-row" style={{ marginTop: 6 }}>
              <p className="hint" style={{ margin: 0 }}>
                Used to draft project names and descriptions from notes. Stored in the local SQLite database on the server and never sent back to the browser.
              </p>
              {keySaved && !clearKey && (
                <button type="button" className="link small danger" onClick={() => { setClearKey(true); setApiKey(""); }}>Remove key</button>
              )}
              {clearKey && <span className="hint">Key will be removed on save.</span>}
            </div>
          </div>

          <div>
            <label className="lbl" htmlFor="st-model">Model</label>
            <input
              id="st-model"
              type="text"
              className="field"
              value={provider === "openai" ? openaiModel : anthropicModel}
              onChange={(e) => (provider === "openai" ? setOpenaiModel(e.target.value) : setAnthropicModel(e.target.value))}
              placeholder={provider === "openai" ? "gpt-4o-mini" : "claude-sonnet-5-5"}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="hint">Leave blank to use the default.</p>
          </div>

          {saveError && <p className="err">{saveError}</p>}
          <div className="actions">
            <span />
            <div className="right">
              <button type="button" onClick={onClose} className="btn-quiet">Cancel</button>
              <button type="submit" className="btn-primary">Save</button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
