// Human-approval handoff: a CSM approves an AI-suggested Next Best Action in
// the UI, and this endpoint forwards it to an n8n workflow to actually carry
// out (create a task, notify someone, log it in a CRM, etc.). The AI never
// acts on its own — this endpoint only ever runs after a human click.
//
// If N8N_APPROVAL_WEBHOOK_URL isn't configured, the action is just logged
// server-side instead of failing — so the approve/UI flow can be demoed
// without an n8n workflow wired up yet.
//
// Development Day 2 hardening — external side effects are opt-in, separate
// from AI mocking: MOCK_AI only ever affected api/analyze.js's AI calls, so
// a webhook URL left over in .env could still fire a real n8n call (real
// email, real Sheet row) during local/test use even with MOCK_AI=true — that
// gap caused a real accidental approval call during a UI check. Requiring
// ENABLE_EXTERNAL_ACTIONS=true as well closes it: a configured webhook URL
// alone is no longer sufficient to reach the outside world.

import { applyGate } from "./_security.js";
import { loadAccountDataset } from "./_accounts.js";
import { computeHealthScore } from "../src/scoring.js";
import { callN8nWebhook, hasWebhookSecret, resolveTimeoutMs, DEFAULT_APPROVAL_TIMEOUT_MS } from "./_n8n.js";
import { claimSignalReview, finishSignalReview } from "./_signal-store.js";

const N8N_APPROVAL_WEBHOOK_URL = process.env.N8N_APPROVAL_WEBHOOK_URL;
// Must be exactly the string "true" — missing, empty, "false", or any other
// value is treated as disabled. Exported for tests only.
export const EXTERNAL_ACTIONS_ENABLED = process.env.ENABLE_EXTERNAL_ACTIONS === "true";
const VALID_CATEGORIES = ["risk_mitigation", "growth"];
// Sprint 03 — Demo Hardening: short on purpose. This endpoint has a real
// side effect (Sheet row + internal email) and is never auto-retried, so a
// hung request should fail fast rather than leave the CSM staring at "Sending…".
const APPROVAL_TIMEOUT_MS = resolveTimeoutMs(process.env.N8N_APPROVAL_TIMEOUT_MS, DEFAULT_APPROVAL_TIMEOUT_MS);

// Sprint 02 — Human Review: this endpoint is the final handoff after a CSM
// has reviewed/edited the AI suggestion in the UI. It must not trust the
// client for anything decision-relevant — re-validates shape/length and
// re-derives the Health Score itself to re-apply the Sprint 01 expansion
// guardrail (a client could otherwise force "growth" through by editing the
// category field directly, bypassing the UI's own guardrailed suggestion).
export default async function handler(req, res) {
  if (!applyGate(req, res)) return;

  const { accountId, action, category, rationale, signalId } = req.body || {};

  let data;
  try { data = await loadAccountDataset(); }
  catch { return res.status(503).json({ error: "Account data is currently unavailable. Please try again." }); }
  const account = data.accounts.find(a => a.accountId === accountId);
  if (!account) return res.status(404).json({ error: "Unknown accountId" });
  const isSignalReview = signalId !== undefined;
  const signal = isSignalReview && typeof signalId === "string" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(signalId)
    ? account.customerSignals?.find(s => s.signalId === signalId) : null;
  if (isSignalReview && (!signal || signal.reviewStatus !== "pending")) {
    return res.status(409).json({ error: "This signal action is not pending review." });
  }

  const trimmedAction = String(action ?? "").trim();
  if (!trimmedAction) {
    return res.status(400).json({ error: "Action cannot be empty" });
  }
  if (trimmedAction.length > 700) {
    return res.status(400).json({ error: "Action must be 700 characters or fewer" });
  }

  const trimmedRationale = String(rationale ?? "").trim();
  if (trimmedRationale.length > 500) {
    return res.status(400).json({ error: "Rationale must be 500 characters or fewer" });
  }

  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Category must be one of: ${VALID_CATEGORIES.join(", ")}` });
  }
  if (signal?.type === "risk" && category !== "risk_mitigation") {
    return res.status(400).json({ error: "A risk signal requires risk mitigation review." });
  }

  const health = computeHealthScore(account);
  if (health.riskCategory === "high" && category === "growth") {
    return res.status(400).json({ error: "This account is high risk; a growth action cannot be sent for it." });
  }

  const csm = data.csms.find(c => c.csmId === account.csmId);
  const reviewedAt = new Date().toISOString();

  const payload = {
    accountId: account.accountId,
    accountName: account.accountName,
    csmName: csm?.name ?? "Unknown",
    action: trimmedAction,
    category,
    rationale: trimmedRationale,
    reviewedByHuman: true,
    approvedAt: reviewedAt,
  };

  // Keep legacy on-demand NBA approvals unchanged. Signal approvals reuse
  // this same decision endpoint, with an atomic persistent claim before any
  // outward call. The reviewer label is a demo CSM assignment, not login proof.
  if (isSignalReview && N8N_APPROVAL_WEBHOOK_URL && EXTERNAL_ACTIONS_ENABLED && !hasWebhookSecret()) {
    return res.status(503).json({ error: "Approval workflow is misconfigured (missing webhook secret). Contact the workflow owner." });
  }
  if (isSignalReview) {
    let claimed;
    try { claimed = await claimSignalReview(signalId, account.csmId, trimmedAction, category, trimmedRationale, reviewedAt); }
    catch { return res.status(503).json({ error: "Review could not be saved. Nothing was sent." }); }
    if (!claimed) return res.status(409).json({ error: "This signal action was already reviewed." });
  }

  if (!EXTERNAL_ACTIONS_ENABLED || !N8N_APPROVAL_WEBHOOK_URL) {
    const reason = !EXTERNAL_ACTIONS_ENABLED ? "ENABLE_EXTERNAL_ACTIONS is not \"true\"" : "no n8n webhook configured";
    if (isSignalReview) {
      try { await finishSignalReview(signalId, "logged"); }
      catch { return res.status(503).json({ error: "Review outcome could not be saved. Do not retry automatically." }); }
    } else {
      console.log(`Human-approved action (${reason}, logged only):`, payload);
    }
    return res.status(200).json({ status: "logged", workflowConnected: false });
  }

  // A configured URL without the shared secret is a misconfiguration, not the
  // "no workflow wired up" demo fallback above — refuse rather than silently
  // logging, and never attempt the external call.
  if (!hasWebhookSecret()) {
    console.error("approve-action.js: N8N_APPROVAL_WEBHOOK_URL is set but N8N_WEBHOOK_SECRET is missing — refusing to call the workflow.");
    return res.status(503).json({ error: "Approval workflow is misconfigured (missing webhook secret). Contact the workflow owner." });
  }

  // No automatic retry: a second silent attempt could append a second Sheet
  // row and send a second internal email for the same approval. If this
  // fails, the CSM sees the error and can deliberately try again from the UI.
  try {
    // callN8nWebhook already guarantees a 2xx response or throws a safe,
    // generic error (see api/_n8n.js) — a non-2xx body is never read here.
    const wres = await callN8nWebhook(N8N_APPROVAL_WEBHOOK_URL, payload, APPROVAL_TIMEOUT_MS);

    // Sprint 05 — Part B: a 2xx status alone is not success. A real approval
    // test found that n8n can return HTTP 200 even when an internal step
    // failed (e.g. an expired Google Sheets credential) — the workflow itself
    // knows it failed, but the HTTP layer didn't reflect that. Success now
    // requires the body to explicitly confirm both fields; anything else
    // (empty body, invalid JSON, missing/wrong fields, a different 2xx body)
    // is a controlled failure. The body content itself is never forwarded to
    // the browser or written to a log, success or failure.
    const body = await wres.json().catch(() => null);
    const isConfirmedSuccess = Boolean(body) && typeof body === "object"
      && body.status === "sent" && body.workflowConnected === true;

    if (!isConfirmedSuccess) {
      if (isSignalReview) await finishSignalReview(signalId, "uncertain").catch(() => {});
      console.error("approve-action.js: n8n webhook returned a 2xx status but did not confirm success (invalid or unexpected response contract).");
      return res.status(502).json({ error: "The approval workflow did not confirm success. Nothing was retried automatically." });
    }

    if (isSignalReview) {
      try { await finishSignalReview(signalId, "sent"); }
      catch { return res.status(503).json({ error: "Workflow accepted the action, but the saved outcome is uncertain. Do not retry." }); }
    }
    return res.status(200).json({ status: "sent", workflowConnected: true });
  } catch (err) {
    if (isSignalReview) await finishSignalReview(signalId, "uncertain").catch(() => {});
    console.error("approve-action.js n8n webhook error:", err.message);
    return res.status(502).json({ error: "Could not reach the approval workflow. Nothing was retried automatically." });
  }
}
