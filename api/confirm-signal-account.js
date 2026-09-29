// Sprint 16 — Customer Intelligence Inbox, Gate 1: Confirm Account.
//
// Separate from Gate 2 (approve-action.js): this endpoint only ever links a
// signal to an account and marks that link as human-confirmed. It never
// proposes, approves, or sends any action, and it never touches case
// lifecycle state — those remain out of scope for this endpoint entirely
// (Gate 2 and case management are separate, later pieces of work).
//
// confirmedByCsmId is taken from the target account's own assigned CSM
// (account.csmId) — the fachlich-zustaendiger CSM, unrelated to who is
// actually logged in. requireDemoAdmin (api/_auth.js) is the real identity
// check: a verified Supabase session, never a client-supplied CSM ID.

import { applyGate } from "./_security.js";
import { requireDemoAdmin } from "./_auth.js";
import { loadAccountDataset } from "./_accounts.js";
import { confirmSignalAccount } from "./_signal-store.js";

const SIGNAL_ID_PATTERN = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

export default async function handler(req, res) {
  if (!applyGate(req, res)) return;
  const user = await requireDemoAdmin(req, res);
  if (!user) return;

  const { signalId, accountId } = req.body || {};

  if (typeof signalId !== "string" || !SIGNAL_ID_PATTERN.test(signalId)) {
    return res.status(400).json({ error: "Invalid signalId" });
  }
  if (typeof accountId !== "string" || !accountId.trim()) {
    return res.status(400).json({ error: "accountId is required" });
  }

  let data;
  try { data = await loadAccountDataset(); }
  catch { return res.status(503).json({ error: "Account data is currently unavailable. Please try again." }); }

  // Server-side validation: accountId must be a real, known account — never
  // trust a client-supplied ID directly, and never let an AI suggestion
  // (suggestedAccountId) be treated as ground truth without this same check.
  const account = data.accounts.find(a => a.accountId === accountId.trim());
  if (!account) return res.status(404).json({ error: "Unknown accountId" });

  const confirmedAt = new Date().toISOString();

  let confirmed;
  try {
    confirmed = await confirmSignalAccount(signalId, account.accountId, account.csmId, confirmedAt, user.id);
  } catch {
    return res.status(503).json({ error: "Confirmation could not be saved. Please try again." });
  }

  // Atomic, conditional update: false means either the signal doesn't exist,
  // or — far more commonly — it was already confirmed (by this same request
  // retried, or by a second reviewer). Either way it is never silently
  // overwritten; the caller gets a clear conflict instead.
  if (!confirmed) {
    return res.status(409).json({ error: "This signal's account was already confirmed, or the signal does not exist." });
  }

  return res.status(200).json({
    status: "confirmed", signalId, accountId: account.accountId,
    confirmedByCsmId: account.csmId, confirmedByUserId: user.id, confirmedAt,
  });
}
