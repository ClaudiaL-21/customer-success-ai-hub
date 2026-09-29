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
  if (String(url).includes("/customer_signals") && init?.method === "PATCH") {
    patchAttempts++;
    const changes = JSON.parse(init.body);
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
