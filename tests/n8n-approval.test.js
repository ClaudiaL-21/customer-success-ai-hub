// Sprint 03 — n8n Demo Hardening: approval-webhook auth header, payload
// fidelity, timeout handling, and no-automatic-retry. Local loopback dummy
// server only — no real n8n, Gmail, or Google Sheets call is ever made.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeHealthScore } from "../src/scoring.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ACCOUNTS = JSON.parse(
  readFileSync(join(__dirname, "..", "data", "accounts.json"), "utf-8")
).accounts;
const LOW_RISK_ACCOUNT = ACCOUNTS.map(a => ({ account: a, health: computeHealthScore(a) }))
  .find(x => x.health.riskCategory === "low").account;

const TEST_ORIGIN = "http://localhost:test-runner";
const TEST_SECRET = "test-only-secret-do-not-use";

let currentHandler = (req, body, res) => { res.writeHead(200); res.end(); };
let requestCount = 0;
const dummyServer = createServer((req, res) => {
  requestCount++;
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => currentHandler(req, body, res));
});
const dummyUrl = await new Promise(resolve => {
  dummyServer.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${dummyServer.address().port}`));
});

process.env.ALLOWED_ORIGINS = TEST_ORIGIN;
process.env.N8N_APPROVAL_WEBHOOK_URL = dummyUrl;
process.env.N8N_WEBHOOK_SECRET = TEST_SECRET;
process.env.N8N_APPROVAL_TIMEOUT_MS = "150"; // short on purpose, keeps the timeout test fast
// Development Day 2 hardening — this file exercises the real-workflow path
// on purpose, so it must opt in explicitly like a real live-demo would.
process.env.ENABLE_EXTERNAL_ACTIONS = "true";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
process.env.DEMO_ADMIN_EMAIL = "claudia@example.test";

const { default: handler } = await import("../api/approve-action.js");

// Sprint 16 — intercept only the Supabase Auth check; everything else (the
// real loopback dummy server above, simulating the real n8n webhook) goes
// through the real fetch.
const AUTH_USERS = {
  "valid-admin-token": { id: "user-claudia-uuid", email: "claudia@example.test" },
  "valid-other-user-token": { id: "user-someone-else-uuid", email: "someone-else@example.test" },
};
const realFetch = globalThis.fetch;
global.fetch = async (url, init) => {
  if (String(url).endsWith("/auth/v1/user")) {
    const token = /^Bearer\s+(.+)$/i.exec(init.headers.Authorization || "")?.[1];
    const user = AUTH_USERS[token];
    return user ? Response.json(user) : new Response("unauthorized", { status: 401 });
  }
  return realFetch(url, init);
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

test("an unauthenticated call is rejected with 401 and never reaches the real webhook", async () => {
  requestCount = 0;
  const { statusCode } = await callHandler({
    accountId: LOW_RISK_ACCOUNT.accountId, action: "Call the customer.", category: "risk_mitigation", rationale: "x",
  }, null);
  assert.equal(statusCode, 401);
  assert.equal(requestCount, 0, "the dummy webhook server must never have been called");
});

test("a valid session belonging to a non-admin user is rejected with 403 and never reaches the real webhook", async () => {
  requestCount = 0;
  const { statusCode } = await callHandler({
    accountId: LOW_RISK_ACCOUNT.accountId, action: "Call the customer.", category: "risk_mitigation", rationale: "x",
  }, "valid-other-user-token");
  assert.equal(statusCode, 403);
  assert.equal(requestCount, 0, "the dummy webhook server must never have been called");
});

test("the payload sent to the real webhook includes reviewedByUserId, distinct from csmName", async () => {
  let received;
  currentHandler = (req, body, res) => {
    received = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "sent", workflowConnected: true }));
  };
  await callHandler({
    accountId: LOW_RISK_ACCOUNT.accountId, action: "Call the customer.", category: "risk_mitigation", rationale: "x",
  });
  assert.equal(received.reviewedByUserId, "user-claudia-uuid");
  assert.notEqual(received.reviewedByUserId, received.csmName);
});

test("approval webhook call carries the shared secret header and the CSM-reviewed payload, incl. reviewedByHuman", async () => {
  let received;
  currentHandler = (req, body, res) => {
    received = { headers: req.headers, body: JSON.parse(body) };
    res.writeHead(200, { "content-type": "application/json" });
    // Sprint 05 — Part B: the app now requires this exact success contract
    // ({status:"sent", workflowConnected:true}), not just any 2xx. An empty
    // 200 body (the old mock shape) is now a controlled failure, not success
    // — see the dedicated contract tests below.
    res.end(JSON.stringify({ status: "sent", workflowConnected: true }));
  };
  const { statusCode, body } = await callHandler({
    accountId: LOW_RISK_ACCOUNT.accountId,
    action: "  Call the customer about the renewal.  ",
    category: "risk_mitigation",
    rationale: "  Top driver right now.  ",
  });
  assert.equal(statusCode, 200);
  assert.equal(body.workflowConnected, true);
  assert.equal(received.headers["x-cs-ai-hub-secret"], TEST_SECRET);
  assert.equal(received.body.accountId, LOW_RISK_ACCOUNT.accountId);
  assert.equal(received.body.action, "Call the customer about the renewal.");
  assert.equal(received.body.rationale, "Top driver right now.");
  assert.equal(received.body.reviewedByHuman, true);
});

test("a slow approval response is aborted at the configured timeout, not left hanging", async () => {
  currentHandler = (req, body, res) => {
    setTimeout(() => { res.writeHead(200); res.end(); }, 400); // well beyond the 150ms timeout
  };
  const start = Date.now();
  const { statusCode, body } = await callHandler({
    accountId: LOW_RISK_ACCOUNT.accountId, action: "Call the customer.", category: "risk_mitigation", rationale: "x",
  });
  const elapsed = Date.now() - start;
  assert.equal(statusCode, 502);
  assert.ok(body.error);
  assert.ok(elapsed < 1000, `expected the 150ms timeout to fire well under 1s, took ${elapsed}ms`);
});

test("a non-2xx approval webhook response body is never leaked into the browser response or server logs", async () => {
  const SENSITIVE_MARKER = "SENSITIVE-MARKER-DO-NOT-LEAK-9c1b";
  currentHandler = (req, body, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`Internal error, debug dump: ${SENSITIVE_MARKER}`);
  };
  const originalConsoleError = console.error;
  const loggedCalls = [];
  console.error = (...args) => { loggedCalls.push(args); };
  let result;
  try {
    result = await callHandler({
      accountId: LOW_RISK_ACCOUNT.accountId, action: "Call the customer.", category: "risk_mitigation", rationale: "x",
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(result.statusCode, 502);
  assert.ok(!JSON.stringify(result.body).includes(SENSITIVE_MARKER), "browser response must not contain the webhook response body");
  assert.ok(!JSON.stringify(loggedCalls).includes(SENSITIVE_MARKER), "server logs must not contain the webhook response body");
});

test("a failing approval webhook is called exactly once — no automatic retry", async () => {
  requestCount = 0;
  currentHandler = (req, body, res) => { res.writeHead(500); res.end("nope"); };
  const { statusCode } = await callHandler({
    accountId: LOW_RISK_ACCOUNT.accountId, action: "Call the customer.", category: "risk_mitigation", rationale: "x",
  });
  assert.equal(statusCode, 502);
  assert.equal(requestCount, 1);
});

// Sprint 05 — Part B: the real bug this closes. n8n can return HTTP 200 while
// an internal step actually failed (e.g. an expired Google Sheets credential
// in the controlled approval test) — the app must not report "sent" unless
// the body explicitly and exactly confirms it.

test("a valid success contract ({status:'sent', workflowConnected:true}) is accepted", async () => {
  currentHandler = (req, body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "sent", workflowConnected: true }));
  };
  const { statusCode, body } = await callHandler({
    accountId: LOW_RISK_ACCOUNT.accountId, action: "Call the customer.", category: "risk_mitigation", rationale: "x",
  });
  assert.equal(statusCode, 200);
  assert.equal(body.status, "sent");
  assert.equal(body.workflowConnected, true);
});

test("an empty 2xx body is a controlled failure, not success", async () => {
  currentHandler = (req, body, res) => { res.writeHead(200); res.end(); };
  const { statusCode, body } = await callHandler({
    accountId: LOW_RISK_ACCOUNT.accountId, action: "Call the customer.", category: "risk_mitigation", rationale: "x",
  });
  assert.equal(statusCode, 502);
  assert.ok(body.error);
});

test("a malformed-JSON 2xx body is a controlled failure, not success", async () => {
  currentHandler = (req, body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("not valid json {");
  };
  const { statusCode, body } = await callHandler({
    accountId: LOW_RISK_ACCOUNT.accountId, action: "Call the customer.", category: "risk_mitigation", rationale: "x",
  });
  assert.equal(statusCode, 502);
  assert.ok(body.error);
});

test("a 2xx body missing the required fields is a controlled failure, not success", async () => {
  currentHandler = (req, body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  };
  const { statusCode } = await callHandler({
    accountId: LOW_RISK_ACCOUNT.accountId, action: "Call the customer.", category: "risk_mitigation", rationale: "x",
  });
  assert.equal(statusCode, 502);
});

test("a 2xx body with the wrong status value is a controlled failure — this is the real incident (n8n HTTP 200 with an internal failure)", async () => {
  currentHandler = (req, body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "error", workflowConnected: false }));
  };
  const { statusCode } = await callHandler({
    accountId: LOW_RISK_ACCOUNT.accountId, action: "Call the customer.", category: "risk_mitigation", rationale: "x",
  });
  assert.equal(statusCode, 502);
});

test("a 2xx body with workflowConnected: false is a controlled failure even if status is 'sent'", async () => {
  currentHandler = (req, body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "sent", workflowConnected: false }));
  };
  const { statusCode } = await callHandler({
    accountId: LOW_RISK_ACCOUNT.accountId, action: "Call the customer.", category: "risk_mitigation", rationale: "x",
  });
  assert.equal(statusCode, 502);
});

test("an invalid-contract 2xx body is never leaked into the browser response or server logs", async () => {
  const SENSITIVE_MARKER = "SENSITIVE-MARKER-DO-NOT-LEAK-2xx-body";
  currentHandler = (req, body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", debug: SENSITIVE_MARKER }));
  };
  const originalConsoleError = console.error;
  const loggedCalls = [];
  console.error = (...args) => { loggedCalls.push(args); };
  let result;
  try {
    result = await callHandler({
      accountId: LOW_RISK_ACCOUNT.accountId, action: "Call the customer.", category: "risk_mitigation", rationale: "x",
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(result.statusCode, 502);
  assert.ok(!JSON.stringify(result.body).includes(SENSITIVE_MARKER));
  assert.ok(!JSON.stringify(loggedCalls).includes(SENSITIVE_MARKER));
});

after(() => new Promise(resolve => dummyServer.close(resolve)));
