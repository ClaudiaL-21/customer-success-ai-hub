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
  const res = await fetch("/api/approve-action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId, action: nba.action, category: nba.category, rationale: nba.rationale, ...(signalId ? { signalId } : {}) }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed (${res.status})`);
  }
  return res.json();
}
