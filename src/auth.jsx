import React, { useEffect, useState } from "react";

let authRequired = false;

// Any 401 after sign-in (expired session, changed password) sends the user back to the login screen.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const res = await nativeFetch(input, init);
  const url = typeof input === "string" ? input : input.url;
  if (res.status === 401 && authRequired && url.startsWith("/api") && !url.startsWith("/api/login")) location.reload();
  return res;
};

export function SignOutButton() {
  if (!authRequired) return null;
  async function signOut() {
    await fetch("/api/logout", { method: "POST" });
    location.reload();
  }
  return <button type="button" onClick={signOut} className="btn-outline">Sign out</button>;
}

export default function AuthGate({ children }) {
  const [state, setState] = useState("checking"); // checking | ok | needs
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/session")
      .then((r) => r.json().then((b) => ({ ok: r.ok, b })))
      .then(({ ok, b }) => {
        if (!ok) { setError(b.error || "Server error"); setState("needs"); return; }
        authRequired = b.authRequired;
        setState(b.authed ? "ok" : "needs");
      })
      .catch(() => setState("ok")); // API unreachable: let the app show its own connection error
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) { authRequired = true; setState("ok"); }
      else setError(res.status === 401 ? "Wrong password" : "Could not sign in");
    } catch {
      setError("Could not reach the server");
    }
    setBusy(false);
  }

  if (state === "ok") return children;
  if (state === "checking") return null;
  return (
    <main className="login">
      <h1 className="login-title">Task Tracker</h1>
      <p className="login-sub">Sign in to manage your projects.</p>
      <form className="login-field" onSubmit={submit}>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          aria-label="Password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" disabled={busy} aria-label="Sign in">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </button>
      </form>
      <div className="login-error" role="alert">{error}</div>
    </main>
  );
}
