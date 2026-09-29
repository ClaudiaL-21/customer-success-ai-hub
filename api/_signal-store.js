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
//
// Sprint 16 — reviewedByUserId is the real, Supabase-Auth-verified caller
// (see api/_auth.js), kept deliberately separate from csmId (the account's
// fachlich-zustaendiger CSM, unrelated to who is actually logged in). Optional
// so nothing here breaks for a caller that predates the auth gate.
export function claimSignalReview(signalId, csmId, action, category, rationale, reviewedAt, reviewedByUserId = null) {
  return patchSignal(signalId, "pending", {
    review_status: "claimed", reviewed_by_csm_id: csmId, reviewed_at: reviewedAt,
    reviewed_action: action, reviewed_category: category, reviewed_rationale: rationale,
    reviewed_by_user_id: reviewedByUserId,
  });
}

export function finishSignalReview(signalId, status) {
  if (!["logged", "sent", "uncertain"].includes(status)) throw new TypeError("Invalid signal review outcome");
  return patchSignal(signalId, "claimed", { review_status: status, delivery_at: new Date().toISOString() });
}

// Sprint 16 — Customer Intelligence Inbox, Gate 1 (Confirm Account). A
// separate low-level helper (not a generalized patchSignal) so Gate 2's
// review-claim behavior above is provably untouched by this addition — the
// filter field differs (account_confirmed, not review_status), and keeping
// them as two small, independent functions is safer to review than adding a
// parameter that changes what an existing, already-shipped function does.
async function patchSignalWhereUnconfirmed(signalId, changes) {
  const { url, headers } = connection();
  const endpoint = new URL("/rest/v1/customer_signals", url);
  endpoint.searchParams.set("signal_id", `eq.${signalId}`);
  endpoint.searchParams.set("account_confirmed", "eq.false");
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

// Atomic, conditional on account_confirmed still being false at update time:
// two concurrent confirmations (or a confirm racing another confirm) can
// never both succeed — the same single-claim guarantee Gate 2 already has
// for action review, applied here to account confirmation instead. Works
// identically for matched/unknown/ambiguous signals; match_status is never
// consulted here, only account_confirmed.
export function confirmSignalAccount(signalId, accountId, confirmedByCsmId, confirmedAt, confirmedByUserId = null) {
  return patchSignalWhereUnconfirmed(signalId, {
    confirmed_account_id: accountId, account_confirmed: true,
    confirmed_by_csm_id: confirmedByCsmId, confirmed_at: confirmedAt,
    confirmed_by_user_id: confirmedByUserId,
  });
}
