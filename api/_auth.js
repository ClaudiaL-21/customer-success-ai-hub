// Sprint 16 — minimal Supabase Auth verification + a single demo-admin
// authorization check. No new user-management system: exactly one real
// identity (the demo admin, this app's one authenticated user) exists, and
// it is granted access to every synthetic account for this demo. A real
// per-CSM permission model is a separate, later initiative.
//
// This never accepts a client-supplied CSM ID as identity proof — the only
// thing trusted here is a Supabase session token, verified against
// Supabase's own /auth/v1/user endpoint on every call (no local JWT
// decoding, no caching of "who this token belongs to").

async function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) return null;
  const token = match[1].trim();
  if (!token) return null;

  let url;
  try { url = new URL(process.env.SUPABASE_URL || ""); } catch { return null; }
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (url.protocol !== "https:" || !key) return null;

  try {
    const response = await fetch(new URL("/auth/v1/user", url), {
      headers: { apikey: key, Authorization: `Bearer ${token}` },
      redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const user = await response.json();
    return user?.id && user?.email ? { id: user.id, email: user.email } : null;
  } catch {
    return null;
  }
}

function isDemoAdmin(user) {
  const adminEmail = process.env.DEMO_ADMIN_EMAIL;
  return Boolean(user?.email && adminEmail && user.email.toLowerCase() === adminEmail.toLowerCase());
}

// Combined gate for Gate 1/2 endpoints: verifies the session token AND the
// demo-admin authorization, writing the response itself on failure — same
// calling convention as _security.js's applyGate (returns the user on
// success, or null with the response already sent on failure).
export async function requireDemoAdmin(req, res) {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    res.status(401).json({ error: "Authentication required." });
    return null;
  }
  if (!isDemoAdmin(user)) {
    res.status(403).json({ error: "Not authorized for this action." });
    return null;
  }
  return user;
}
