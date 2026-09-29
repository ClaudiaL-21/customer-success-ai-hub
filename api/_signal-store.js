import { AccountDataError } from "./_accounts.js";

function connection() {
  const url = new URL(process.env.SUPABASE_URL || "");
  const key = process.env.SUPABASE_SECRET_KEY;
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !key) {
    throw new AccountDataError();
  }
  const headers = { apikey: key, "content-type": "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return { url, headers };
}

async function patchSignal(signalId, expectedStatus, changes) {
  const { url, headers } = connection();
  const endpoint = new URL("/rest/v1/customer_signals", url);
  endpoint.searchParams.set("signal_id", `eq.${signalId}`);
  endpoint.searchParams.set("review_status", `eq.${expectedStatus}`);
  endpoint.searchParams.set("select", "signal_id");
  try {
    const response = await fetch(endpoint, {
      method: "PATCH", headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify(changes), redirect: "error", signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new AccountDataError();
    const rows = await response.json();
    return Array.isArray(rows) && rows.length === 1;
  } catch {
    throw new AccountDataError();
  }
}

// A conditional update is the single-use claim: concurrent review clicks can
// never both advance a pending proposal to an outbound n8n side effect.
export function claimSignalReview(signalId, csmId, action, category, rationale, reviewedAt) {
  return patchSignal(signalId, "pending", {
    review_status: "claimed", reviewed_by_csm_id: csmId, reviewed_at: reviewedAt,
    reviewed_action: action, reviewed_category: category, reviewed_rationale: rationale,
  });
}

export function finishSignalReview(signalId, status) {
  if (!["logged", "sent", "uncertain"].includes(status)) throw new TypeError("Invalid signal review outcome");
  return patchSignal(signalId, "claimed", { review_status: status, delivery_at: new Date().toISOString() });
}
