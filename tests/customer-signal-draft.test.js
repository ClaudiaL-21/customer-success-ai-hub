// Sprint 15C Final Showcase Flow — Gate 2 now hands the Approval workflow a
// pre-drafted customer reply (customerDraft) so it can create a Gmail draft
// addressed to the original sender, instead of only an internal
// notification. Modeled on tests/n8n-approval.test.js's real-loopback-server
// pattern; only the signal-review-specific customerDraft behavior is new
// here, not a duplicate of that file's webhook-contract coverage.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const dataset = JSON.parse(readFileSync(new URL("../data/accounts.json", import.meta.url), "utf8"));
const account = dataset.accounts[0];

const TEST_ORIGIN = "http://localhost:test-runner";
const TEST_SECRET = "test-only-secret-do-not-use";

let currentHandler = (req, body, res) => { res.writeHead(200); res.end(); };
const dummyServer = createServer((req, res) => {
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
process.env.ENABLE_EXTERNAL_ACTIONS = "true";
process.env.ACCOUNT_DATA_SOURCE = "supabase";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SECRET_KEY = "test-server-key";
process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
process.env.DEMO_ADMIN_EMAIL = "claudia@example.test";

const { default: handler } = await import("../api/approve-action.js");

let reviewStatus = "pending";
let signalId = "da115850-8b4b-4aab-8e13-2e688991942a";
let signalRow = { sender_email: "customer@example.test", topic: "Login outage", proposed_response: "Hi, we're on it and will follow up shortly.", evidence: "We can't log in since this morning." };

const realFetch = globalThis.fetch;
global.fetch = async (url, init) => {
  if (String(url).endsWith("/auth/v1/user")) {
    const token = /^Bearer\s+(.+)$/i.exec(init.headers.Authorization || "")?.[1];
    return token === "valid-admin-token"
      ? Response.json({ id: "user-claudia-uuid", email: "claudia@example.test" })
      : new Response("unauthorized", { status: 401 });
  }
  if (String(url).endsWith("/rpc/hub_account_dataset")) {
    return Response.json({ ...dataset, accounts: dataset.accounts.map(a => a.accountId === account.accountId
      ? { ...a, customerSignals: [{ signalId, type: "risk", reviewStatus, healthDelta: -5 }] } : a) });
  }
  if (String(url).includes("/customer_signals") && (!init.method || init.method === "GET")) {
    return Response.json(signalRow ? [signalRow] : []);
  }
  if (String(url).includes("/customer_signals") && init.method === "PATCH") {
    const changes = JSON.parse(init.body);
    if (String(url).includes("review_status=eq.pending") && reviewStatus === "pending") {
      reviewStatus = changes.review_status;
      return Response.json([{ signal_id: signalId }]);
    }
    if (String(url).includes("review_status=eq.claimed") && reviewStatus === "claimed") {
      reviewStatus = changes.review_status;
      return Response.json([{ signal_id: signalId }]);
    }
    return Response.json([]);
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

test("Gate 2 approval sends exactly one customerDraft (sender, derived subject, body) to the Approval workflow", async () => {
  let received;
  currentHandler = (req, body, res) => {
    received = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "sent", workflowConnected: true }));
  };
  const { statusCode } = await callHandler({
    accountId: account.accountId, signalId, action: "Investigate the login outage.",
    category: "risk_mitigation", rationale: "Blocking the whole team.",
  });
  assert.equal(statusCode, 200);
  assert.equal(received.customerDraft.senderEmail, "customer@example.test");
  assert.equal(received.customerDraft.subject, "Re: Login outage");
  // No To field exists on the n8n Gmail node's Draft/Create operation (n8n
  // limitation, confirmed against the actual node) — the sender address and
  // the original message excerpt go into the body itself instead, so the
  // draft is both addressable by hand and has its original context.
  assert.match(received.customerDraft.body, /^Hi, we're on it and will follow up shortly\./);
  assert.match(received.customerDraft.body, /Reply to: customer@example\.test/);
  assert.match(received.customerDraft.body, /We can't log in since this morning\./);
});

test("no customerDraft is sent when the signal has no stored proposed_response", async () => {
  reviewStatus = "pending";
  signalId = "d5773185-3911-4907-92ec-0f3f43ab527b";
  signalRow = { sender_email: "customer@example.test", topic: "Login outage", proposed_response: null };
  let received;
  currentHandler = (req, body, res) => {
    received = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "sent", workflowConnected: true }));
  };
  await callHandler({
    accountId: account.accountId, signalId, action: "Investigate.",
    category: "risk_mitigation", rationale: "x",
  });
  assert.equal("customerDraft" in received, false);
});

test("the legacy on-demand NBA path (no signalId) never carries a customerDraft", async () => {
  let received;
  currentHandler = (req, body, res) => {
    received = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "sent", workflowConnected: true }));
  };
  await callHandler({ accountId: account.accountId, action: "Call the customer.", category: "risk_mitigation", rationale: "x" });
  assert.equal("customerDraft" in received, false);
});

after(() => new Promise(resolve => dummyServer.close(resolve)));
