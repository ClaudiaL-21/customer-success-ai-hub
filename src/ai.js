import { getAuthToken, clearAuthToken } from "./auth.js";

// A 401 from a Bearer-protected endpoint means the stored token is missing
// or has expired server-side — never a client-side problem to retry as-is.
// Drop it so the next reload shows the login form again, and say so plainly
// instead of surfacing the generic "Authentication required." dead end.
async function readAuthGatedError(res) {
  const err = await res.json().catch(() => ({}));
  if (res.status === 401) {
    clearAuthToken();
    return new Error("Your session has expired. Please reload the page and sign in again.");
  }
  return new Error(err.error || `Request failed (${res.status})`);
}

async function callAnalyze(body) {
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export function fetchAccountInsight(accountId) {
  return callAnalyze({ mode: "account-insight", accountId });
}

export function askAboutAccount(accountId, question) {
  return callAnalyze({ mode: "ask", accountId, question });
}

export function fetchTeamPriority(csmId) {
  return callAnalyze({ mode: "team-priority", csmId });
}

export function askAboutPortfolio(accountIds, question, viewLabel) {
  return callAnalyze({ mode: "portfolio-ask", accountIds, question, viewLabel });
}

export function fetchQbrDraft(accountId) {
  return callAnalyze({ mode: "qbr-draft", accountId });
}

export function fetchPortfolioSummary(accountIds) {
  return callAnalyze({ mode: "portfolio-summary", accountIds });
}

// QBR Customer Presentation export — separate from callAnalyze() since a
// success response is a binary .pptx (application/vnd...presentation), not
// JSON; only the error path is JSON. `sections` here is exactly what
// selectCustomerSafeSections() + the CSM's reviewed safeText produced —
// never internal/customerSafeDefault — see src/app.js's call site.
export async function generateQbrPptx(accountId, sections) {
  const res = await fetch("/api/qbr-export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId, sections }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const error = new Error(err.error || `Request failed (${res.status})`);
    error.warnings = Array.isArray(err.warnings) ? err.warnings : null;
    throw error;
  }
  const blob = await res.blob();
  const match = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "");
  return { blob, filename: match ? match[1] : "Customer-QBR.pptx" };
}

export async function approveAction(accountId, nba, signalId = null) {
  // Sprint 16 — every approval (legacy on-demand NBA and signal-based review
  // alike) requires a Supabase session, matching api/approve-action.js's
  // endpoint-wide identity check.
  const headers = { "content-type": "application/json", authorization: `Bearer ${getAuthToken() || ""}` };
  const res = await fetch("/api/approve-action", {
    method: "POST",
    headers,
    body: JSON.stringify({ accountId, action: nba.action, category: nba.category, rationale: nba.rationale, ...(signalId ? { signalId } : {}) }),
  });
  if (!res.ok) throw await readAuthGatedError(res);
  return res.json();
}

// Sprint 16 — Customer Intelligence Inbox, Package 6. api/inbox.js now
// requires the same verified session as Gate 1/2 (see its own comment), so
// this sends the same Bearer token those calls do.
export async function fetchInboxSignals() {
  const res = await fetch("/api/inbox", { cache: "no-store", headers: { authorization: `Bearer ${getAuthToken() || ""}` } });
  if (!res.ok) throw await readAuthGatedError(res);
  const { signals } = await res.json();
  return signals;
}

// Gate 1 — the account confirmation itself always requires a session,
// matching api/confirm-signal-account.js's endpoint-wide identity check.
export async function confirmSignalAccount(signalId, accountId) {
  const res = await fetch("/api/confirm-signal-account", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${getAuthToken() || ""}` },
    body: JSON.stringify({ signalId, accountId }),
  });
  if (!res.ok) throw await readAuthGatedError(res);
  return res.json();
}
