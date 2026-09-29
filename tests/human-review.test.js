// Sprint 02 — Human Review: server-side validation tests for api/approve-action.js.
// Run with: node --test tests/
//
// Calls the exported handler directly with a minimal fake req/res (same shape
// dev-server.js's shimRes uses) — no real HTTP server, no n8n webhook, no AI
// provider involved. ALLOWED_ORIGINS is set in-process before each call so the
// shared origin gate in api/_security.js passes without touching .env.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeHealthScore } from "../src/scoring.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ACCOUNTS = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "accounts.json"), "utf-8")
).accounts;

const TEST_ORIGIN = "http://localhost:test-runner";
process.env.ALLOWED_ORIGINS = TEST_ORIGIN;
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
process.env.DEMO_ADMIN_EMAIL = "claudia@example.test";

// Must run BEFORE api/approve-action.js is loaded: that module reads
// N8N_APPROVAL_WEBHOOK_URL into a module-level const at import time. A static
// `import` at the top of this file is resolved before any of our own
// top-level code runs, so an externally-set webhook URL in the environment
// could survive into the handler despite a later `delete`. Clearing the env
// var first and only then dynamically importing the module is what actually
// guarantees the handler never sees a real webhook URL in this test run.
delete process.env.N8N_APPROVAL_WEBHOOK_URL;
// Development Day 2 hardening — set to "true" here on purpose: this file's
// no-webhook-configured case must stay "logged" even when external actions
// ARE enabled, proving ENABLE_EXTERNAL_ACTIONS=true alone is not sufficient
// without an actual webhook URL (see the added test below).
process.env.ENABLE_EXTERNAL_ACTIONS = "true";
const { default: handler } = await import("../api/approve-action.js");

function findAccount(riskCategory) {
  const hit = ACCOUNTS.map(a => ({ account: a, health: computeHealthScore(a) }))
    .find(x => x.health.riskCategory === riskCategory);
  assert.ok(hit, `expected at least one ${riskCategory}-risk account in the dataset`);
  return hit.account;
}

const HIGH_RISK_ACCOUNT = findAccount("high");
const LOW_RISK_ACCOUNT = findAccount("low");

// Sprint 16 — the whole endpoint now requires a verified Supabase session
// (see api/approve-action.js). Only the /auth/v1/user check is intercepted;
// everything else (no external n8n call happens in this file at all) is
// untouched by this addition.
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
  throw new Error(`Unexpected test request: ${url}`);
};

function callHandler(body, token = "valid-admin-token") {
  return new Promise((resolve, reject) => {
    const headers = { origin: TEST_ORIGIN };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = { method: "POST", headers, socket: {}, body };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      setHeader() {},
      json(obj) { resolve({ statusCode: this.statusCode, body: obj }); },
      end() { resolve({ statusCode: this.statusCode, body: null }); },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test("rejects an unauthenticated call with 401 — no account lookup, no external action", async () => {
  const { statusCode } = await callHandler(
    { accountId: LOW_RISK_ACCOUNT.accountId, action: "Call the customer.", category: "risk_mitigation", rationale: "x" },
    null,
  );
  assert.equal(statusCode, 401);
});

test("rejects a valid session belonging to a non-admin user with 403 — no external action", async () => {
  const { statusCode } = await callHandler(
    { accountId: LOW_RISK_ACCOUNT.accountId, action: "Call the customer.", category: "risk_mitigation", rationale: "x" },
    "valid-other-user-token",
  );
  assert.equal(statusCode, 403);
});

test("empty action is rejected", async () => {
  const { statusCode, body } = await callHandler({
    accountId: LOW_RISK_ACCOUNT.accountId, action: "   ", category: "risk_mitigation", rationale: "x",
  });
  assert.equal(statusCode, 400);
  assert.match(body.error, /empty/i);
});

test("action longer than 700 characters is rejected", async () => {
  const { statusCode, body } = await callHandler({
    accountId: LOW_RISK_ACCOUNT.accountId, action: "a".repeat(701), category: "risk_mitigation", rationale: "x",
  });
  assert.equal(statusCode, 400);
  assert.match(body.error, /700/);
});

test("rationale longer than 500 characters is rejected", async () => {
  const { statusCode, body } = await callHandler({
    accountId: LOW_RISK_ACCOUNT.accountId, action: "Call the customer.", category: "risk_mitigation", rationale: "r".repeat(501),
  });
  assert.equal(statusCode, 400);
  assert.match(body.error, /500/);
});

test("unknown category is rejected, not silently coerced", async () => {
  const { statusCode, body } = await callHandler({
    accountId: LOW_RISK_ACCOUNT.accountId, action: "Call the customer.", category: "expand_wildly", rationale: "x",
  });
  assert.equal(statusCode, 400);
  assert.match(body.error, /category/i);
});

test("unknown accountId is rejected", async () => {
  const { statusCode, body } = await callHandler({
    accountId: "ACC-does-not-exist", action: "Call the customer.", category: "risk_mitigation", rationale: "x",
  });
  assert.equal(statusCode, 404);
  assert.match(body.error, /accountId/i);
});

test("high risk + growth is rejected by the approval endpoint itself, even bypassing the UI guardrail", async () => {
  const { statusCode, body } = await callHandler({
    accountId: HIGH_RISK_ACCOUNT.accountId, action: "Propose an upsell.", category: "growth", rationale: "x",
  });
  assert.equal(statusCode, 400);
  assert.match(body.error, /high risk/i);
});

test("valid risk-mitigation submission is trimmed and accepted (logged, no n8n configured)", async () => {
  const { statusCode, body } = await callHandler({
    accountId: HIGH_RISK_ACCOUNT.accountId,
    action: "   Call the customer about the open ticket.   ",
    category: "risk_mitigation",
    rationale: "   Top risk driver.   ",
  });
  assert.equal(statusCode, 200);
  assert.equal(body.status, "logged");
  assert.equal(body.workflowConnected, false);
});

test("ENABLE_EXTERNAL_ACTIONS=true without a configured webhook URL still safely logs, does not error", async () => {
  const { statusCode, body } = await callHandler({
    accountId: LOW_RISK_ACCOUNT.accountId, action: "Call the customer.", category: "risk_mitigation", rationale: "x",
  });
  assert.equal(statusCode, 200);
  assert.deepEqual(body, { status: "logged", workflowConnected: false });
});

test("valid growth submission for a low-risk account is accepted", async () => {
  const { statusCode, body } = await callHandler({
    accountId: LOW_RISK_ACCOUNT.accountId, action: "Propose an unused module pilot.", category: "growth", rationale: "Healthy account, good timing.",
  });
  assert.equal(statusCode, 200);
  assert.equal(body.status, "logged");
});

test("reviewedByHuman: true and the trimmed CSM-edited text reach the final payload", async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args);
  try {
    await callHandler({
      accountId: LOW_RISK_ACCOUNT.accountId,
      action: "  Edited-by-CSM action text.  ",
      category: "risk_mitigation",
      rationale: "  Edited-by-CSM rationale.  ",
    });
  } finally {
    console.log = originalLog;
  }
  const loggedPayload = logs.flat().find(arg => arg && typeof arg === "object" && arg.reviewedByHuman !== undefined);
  assert.ok(loggedPayload, "expected the logged payload to be captured");
  assert.equal(loggedPayload.reviewedByHuman, true);
  assert.equal(loggedPayload.action, "Edited-by-CSM action text.");
  assert.equal(loggedPayload.rationale, "Edited-by-CSM rationale.");
});
