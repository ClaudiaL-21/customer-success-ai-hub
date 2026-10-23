import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dataset = JSON.parse(readFileSync(new URL("../data/accounts.json", import.meta.url), "utf8"));
const account = dataset.accounts[0];
const otherAccount = dataset.accounts[1];
const signalId = "9e232ee6-cfaa-4a30-82d3-665696a44c98";

process.env.ACCOUNT_DATA_SOURCE = "supabase";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SECRET_KEY = "test-server-key";
process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
process.env.DEMO_ADMIN_EMAIL = "claudia@example.test";
process.env.ALLOWED_ORIGINS = "http://localhost:test";
const { default: handler } = await import("../api/confirm-signal-account.js");

let accountConfirmed = false;
let confirmedAccountId = null;
let patchAttempts = 0;
let lastPatchChanges = null;
// hub_inbox_dataset() rows a test cares about, keyed by signalId — only the
// fields confirm-signal-account.js's activation logic actually reads.
// Defaults to none: existing tests below don't exercise activation at all,
// so an unlisted signalId simply yields no match (activation stays null),
// exactly like today's behavior before this field existed.
let inboxSignals = [];

// Simulated Supabase Auth users, keyed by the bearer token a test sends.
const AUTH_USERS = {
  "valid-admin-token": { id: "user-claudia-uuid", email: "claudia@example.test" },
  "valid-other-user-token": { id: "user-someone-else-uuid", email: "someone-else@example.test" },
};

global.fetch = async (url, init) => {
  if (String(url).endsWith("/auth/v1/user")) {
    const token = /^Bearer\s+(.+)$/i.exec(init.headers.Authorization || "")?.[1];
    const user = AUTH_USERS[token];
    return user ? Response.json(user) : new Response("unauthorized", { status: 401 });
  }
  if (String(url).endsWith("/rpc/hub_account_dataset")) {
    return Response.json(dataset);
  }
  if (String(url).endsWith("/rpc/hub_inbox_dataset")) {
    return Response.json(inboxSignals);
  }
  if (String(url).includes("/customer_signals") && init?.method === "PATCH") {
    patchAttempts++;
    const changes = JSON.parse(init.body);
    lastPatchChanges = changes;
    if (String(url).includes("account_confirmed=eq.false") && !accountConfirmed) {
      accountConfirmed = true;
      confirmedAccountId = changes.confirmed_account_id;
      return Response.json([{ signal_id: signalId }]);
    }
    return Response.json([]); // already confirmed (or unmatched row) -> zero rows
  }
  throw new Error(`Unexpected test request: ${url}`);
};

function call(body, token = "valid-admin-token") {
  return new Promise((resolve, reject) => {
    const headers = { origin: "http://localhost:test" };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = { method: "POST", headers, socket: {}, body };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, setHeader() {},
      json(value) { resolve({ status: this.statusCode, body: value }); }, end() { resolve({ status: this.statusCode }); } };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test("rejects a call with no Authorization header at all — 401, before any account lookup", async () => {
  const result = await call({ signalId, accountId: account.accountId }, null);
  assert.equal(result.status, 401);
  assert.equal(patchAttempts, 0);
});

test("rejects a valid session token belonging to a non-admin user — 403, not silently allowed", async () => {
  const result = await call({ signalId, accountId: account.accountId }, "valid-other-user-token");
  assert.equal(result.status, 403);
  assert.equal(patchAttempts, 0);
});

test("rejects an unrecognized/invalid bearer token — 401", async () => {
  const result = await call({ signalId, accountId: account.accountId }, "totally-made-up-token");
  assert.equal(result.status, 401);
});

test("confirms an unconfirmed signal exactly once and rejects a repeat attempt (atomic, no silent overwrite)", async () => {
  const body = { signalId, accountId: account.accountId };
  const first = await call(body);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "confirmed");
  assert.equal(first.body.accountId, account.accountId);
  assert.equal(first.body.confirmedByCsmId, account.csmId);
  assert.equal(first.body.confirmedByUserId, "user-claudia-uuid");
  assert.ok(first.body.confirmedAt);
  assert.equal(accountConfirmed, true);
  assert.equal(confirmedAccountId, account.accountId);
  assert.equal(patchAttempts, 1);

  // Second attempt (same or different account) must be rejected, never silently overwritten.
  const second = await call({ signalId, accountId: otherAccount.accountId });
  assert.equal(second.status, 409);
  assert.equal(patchAttempts, 2); // attempted, but the conditional filter rejected it
  assert.equal(confirmedAccountId, account.accountId); // unchanged — the first confirmation stands
});

test("rejects an unknown accountId with 404 and never reaches the database write", async () => {
  patchAttempts = 0;
  const result = await call({ signalId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", accountId: "ACC-does-not-exist" });
  assert.equal(result.status, 404);
  assert.equal(patchAttempts, 0); // validated and rejected before any PATCH was attempted
});

test("rejects a malformed signalId with 400", async () => {
  const result = await call({ signalId: "not-a-uuid", accountId: account.accountId });
  assert.equal(result.status, 400);
});

test("rejects a missing accountId with 400", async () => {
  const result = await call({ signalId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
  assert.equal(result.status, 400);
});

test("confirmation logic never reads match_status — works identically for unknown/ambiguous signals", async () => {
  accountConfirmed = false;
  confirmedAccountId = null;
  patchAttempts = 0;
  // A signalId that, in reality, could belong to a match_status='unknown' or
  // 'ambiguous' row (account_id null in the DB) — this endpoint's only gate
  // is account_confirmed=false, so it must succeed the same way regardless.
  const unknownSenderSignalId = "d5773185-3911-4907-92ec-0f3f43ab527b";
  const result = await call({ signalId: unknownSenderSignalId, accountId: account.accountId });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "confirmed");
  assert.equal(patchAttempts, 1);
});

// Sprint 15C Final Integration Fix — a signal with no automatic account
// match at ingestion never got its review pipeline started (health_delta
// stuck at 0, review_status stuck at null) even though the AI already
// produced a proposedAction. Confirming the account is what makes it known
// for the first time, so that's when activation must happen — see
// api/confirm-signal-account.js.
test("activates Health/NBA on first confirmation for a high-urgency risk signal that had no account match at ingestion", async () => {
  accountConfirmed = false; confirmedAccountId = null; patchAttempts = 0; lastPatchChanges = null;
  const sid = "aaaa1111-1111-1111-1111-111111111111";
  inboxSignals = [{ signalId: sid, type: "risk", urgency: "high", proposedAction: "Escalate to support lead", reviewStatus: null }];
  const result = await call({ signalId: sid, accountId: account.accountId });
  assert.equal(result.status, 200);
  assert.equal(lastPatchChanges.review_status, "pending");
  assert.equal(lastPatchChanges.health_delta, -10);
});

test("activates Health/NBA with the medium/low-urgency delta for a matched-after-confirmation risk signal", async () => {
  accountConfirmed = false; confirmedAccountId = null; patchAttempts = 0; lastPatchChanges = null;
  const sid = "aaaa2222-2222-2222-2222-222222222222";
  inboxSignals = [{ signalId: sid, type: "risk", urgency: "medium", proposedAction: "Schedule a check-in call", reviewStatus: null }];
  const result = await call({ signalId: sid, accountId: account.accountId });
  assert.equal(result.status, 200);
  assert.equal(lastPatchChanges.review_status, "pending");
  assert.equal(lastPatchChanges.health_delta, -5);
});

test("activates review (health_delta 0) for a growth signal that had no account match at ingestion", async () => {
  accountConfirmed = false; confirmedAccountId = null; patchAttempts = 0; lastPatchChanges = null;
  const sid = "aaaa3333-3333-3333-3333-333333333333";
  inboxSignals = [{ signalId: sid, type: "growth", urgency: "low", proposedAction: "Offer the Advanced tier", reviewStatus: null }];
  const result = await call({ signalId: sid, accountId: account.accountId });
  assert.equal(result.status, 200);
  assert.equal(lastPatchChanges.review_status, "pending");
  assert.equal(lastPatchChanges.health_delta, 0);
});

test("never activates a routine signal (no proposedAction to review)", async () => {
  accountConfirmed = false; confirmedAccountId = null; patchAttempts = 0; lastPatchChanges = null;
  const sid = "aaaa4444-4444-4444-4444-444444444444";
  inboxSignals = [{ signalId: sid, type: "routine", urgency: "low", proposedAction: null, reviewStatus: null }];
  const result = await call({ signalId: sid, accountId: account.accountId });
  assert.equal(result.status, 200);
  assert.equal("review_status" in lastPatchChanges, false);
  assert.equal("health_delta" in lastPatchChanges, false);
});

test("never re-activates a signal whose review pipeline already started at ingestion (automatic match)", async () => {
  accountConfirmed = false; confirmedAccountId = null; patchAttempts = 0; lastPatchChanges = null;
  const sid = "aaaa5555-5555-5555-5555-555555555555";
  // Already matched at ingestion: review_status is already "pending", not
  // null — the exact signal confirm-signal-account.js must leave alone.
  inboxSignals = [{ signalId: sid, type: "risk", urgency: "high", proposedAction: "Escalate to support lead", reviewStatus: "pending" }];
  const result = await call({ signalId: sid, accountId: account.accountId });
  assert.equal(result.status, 200);
  assert.equal("review_status" in lastPatchChanges, false);
  assert.equal("health_delta" in lastPatchChanges, false);
});
