import React, { useEffect, useState } from "react";

const KEY = "taskTrackerPassword";
const read = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };
const write = (v) => { try { localStorage.setItem(KEY, v); } catch { /* storage unavailable */ } };

// Every /api request carries the saved password (ignored by the server when no password is set).
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (!url.startsWith("/api")) return nativeFetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set("x-app-password", read());
  return nativeFetch(input, { ...init, headers });
};

async function login() {
  const res = await fetch("/api/login", { method: "POST" });
  return res.ok;
}

export default function AuthGate({ children }) {
  const [state, setState] = useState("checking"); // checking | ok | needs
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    login().then((ok) => setState(ok ? "ok" : "needs"), () => setState("ok"));
  }, []);

  async function submit(e) {
    e.preventDefault();
    write(password);
    if (await login()) setState("ok");
    else setError("Wrong password");
  }

  if (state === "ok") return children;
  if (state === "checking") return null;
  return (
    <form onSubmit={submit} style={{ maxWidth: 320, margin: "20vh auto", display: "grid", gap: 12, padding: "0 16px" }}>
      <h2>Task Tracker</h2>
      <input type="password" autoFocus placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <div role="alert">{error}</div>}
      <button type="submit">Sign in</button>
    </form>
  );
}
