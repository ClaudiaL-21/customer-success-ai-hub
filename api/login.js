// Sprint 16 — server-side proxy to Supabase Auth's password grant. The
// browser never talks to Supabase directly and never sees SUPABASE_URL or
// any key beyond the one-time access token this endpoint returns — this
// also avoids needing a Supabase client library or any new external script
// in the browser (this app's CSP only allows same-origin script/connect).
//
// SUPABASE_SECRET_KEY (service role) is never used or exposed here — only
// SUPABASE_PUBLISHABLE_KEY, which is designed to be safe for this exact use.

import { applyGate } from "./_security.js";

export default async function handler(req, res) {
  if (!applyGate(req, res)) return;

  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  let url;
  try { url = new URL(process.env.SUPABASE_URL || ""); } catch { url = null; }
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || url.protocol !== "https:" || !key) {
    return res.status(503).json({ error: "Sign-in is not available right now." });
  }

  try {
    const response = await fetch(new URL("/auth/v1/token?grant_type=password", url), {
      method: "POST",
      headers: { apikey: key, "content-type": "application/json" },
      body: JSON.stringify({ email: email.trim(), password }),
      redirect: "error", signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return res.status(401).json({ error: "Invalid email or password." });
    const data = await response.json();
    if (!data?.access_token) return res.status(401).json({ error: "Invalid email or password." });
    return res.status(200).json({ accessToken: data.access_token });
  } catch {
    return res.status(503).json({ error: "Sign-in is not available right now." });
  }
}
