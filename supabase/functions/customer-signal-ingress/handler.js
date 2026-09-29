// n8n only receives this function's dedicated token, never a Supabase key.
// All payload fields are untrusted, including the classifier's output.
const FIELDS = ["messageId", "senderEmail", "topic", "signalType", "sentiment", "urgency", "summary", "evidence", "classifier", "proposedAction", "proposedRationale"];
const CHOICES = {
  signalType: ["risk", "growth", "routine"],
  sentiment: ["positive", "neutral", "negative"],
  urgency: ["low", "medium", "high"],
};
const LIMITS = { topic: 100, summary: 500, evidence: 300, classifier: 100, proposedAction: 700, proposedRationale: 500 };

export function validateSignalPayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(k => !FIELDS.includes(k))) return null;
  const payload = {};
  for (const field of FIELDS) {
    if (field === "proposedAction" || field === "proposedRationale") continue;
    if (typeof raw[field] !== "string") return null;
    payload[field] = raw[field].trim();
  }
  if (!/^[a-f\d]{10,160}$/i.test(payload.messageId)) return null;
  const sender = /^(?:[^<>\r\n]*<)?([^<>\s@]+@[^<>\s@]+)\s*>?$/.exec(payload.senderEmail);
  if (!sender) return null;
  payload.senderEmail = sender[1].toLowerCase();
  if (payload.senderEmail.length > 254 || !/^[^@]+@[^@]+\.[^@]+$/.test(payload.senderEmail)) return null;
  if (Object.entries(CHOICES).some(([field, allowed]) => !allowed.includes(payload[field]))) return null;
  if (Object.entries(LIMITS).some(([field, max]) => field in payload && (!payload[field] || payload[field].length > max))) return null;
  if (["risk", "growth"].includes(payload.signalType)) {
    for (const field of ["proposedAction", "proposedRationale"]) {
      if (typeof raw[field] !== "string") return null;
      payload[field] = raw[field].trim();
      if (!payload[field] || payload[field].length > LIMITS[field]) return null;
    }
  } else if (raw.proposedAction !== undefined || raw.proposedRationale !== undefined) {
    return null;
  }
  return payload;
}

async function equalSecret(a, b) {
  const enc = new TextEncoder();
  const [left, right] = await Promise.all([a, b].map(v => crypto.subtle.digest("SHA-256", enc.encode(v))));
  const l = new Uint8Array(left), r = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < l.length; i++) difference |= l[i] ^ r[i];
  return difference === 0;
}

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function handleRequest(req, env, transport = fetch) {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const expected = env.get("CUSTOMER_SIGNAL_INGRESS_TOKEN");
  if (!expected || expected.length < 32) return json({ error: "Ingress unavailable" }, 503);
  const supplied = req.headers.get("x-cs-signal-token") || "";
  if (!supplied || !(await equalSecret(supplied, expected))) return json({ error: "Unauthorized" }, 401);
  if (!/^application\/json(?:;|$)/i.test(req.headers.get("content-type") || "")) return json({ error: "JSON required" }, 415);
  const text = await req.text();
  if (text.length > 8192) return json({ error: "Payload too large" }, 413);
  let raw;
  try { raw = JSON.parse(text); } catch { return json({ error: "Invalid JSON" }, 400); }
  const payload = validateSignalPayload(raw);
  if (!payload) return json({ error: "Invalid signal payload" }, 400);

  const key = (() => {
    try { return JSON.parse(env.get("SUPABASE_SECRET_KEYS") || "{}").default; } catch { return null; }
  })() || env.get("SUPABASE_SERVICE_ROLE_KEY");
  const url = env.get("SUPABASE_URL");
  if (!key || !url) return json({ error: "Ingress unavailable" }, 503);
  const headers = { apikey: key, "content-type": "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  try {
    const response = await transport(new URL("/rest/v1/rpc/hub_ingest_customer_signal", url), {
      method: "POST", headers, body: JSON.stringify({ payload }), redirect: "error", signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return json({ error: "Signal could not be saved" }, 503);
    const result = await response.json();
    if (!result || typeof result.signalId !== "string" || !["matched", "unknown", "ambiguous"].includes(result.matchStatus)) {
      return json({ error: "Invalid database response" }, 503);
    }
    return json({ signalId: result.signalId, matchStatus: result.matchStatus, duplicate: result.duplicate === true }, 200);
  } catch {
    return json({ error: "Signal could not be saved" }, 503);
  }
}
