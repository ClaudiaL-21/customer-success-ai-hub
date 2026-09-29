// Development Day 2 hardening — external side effects are opt-in, separate
// from N8N_APPROVAL_WEBHOOK_URL being configured. This reproduces the exact
// incident scenario: a real webhook URL present in the environment, but
// ENABLE_EXTERNAL_ACTIONS never explicitly set — must never reach the
// network. Local loopback dummy server only; a request reaching it would
// mean a real webhook call slipped through.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const TEST_ORIGIN = "http://localhost:test-runner";

let requestCount = 0;
const dummyServer = createServer((req, res) => {
  requestCount++;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "sent", workflowConnected: true }));
});
const dummyUrl = await new Promise(resolve => {
  dummyServer.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${dummyServer.address().port}`));
});

process.env.ALLOWED_ORIGINS = TEST_ORIGIN;
process.env.N8N_APPROVAL_WEBHOOK_URL = dummyUrl;
process.env.N8N_WEBHOOK_SECRET = "test-only-secret-do-not-use";
delete process.env.ENABLE_EXTERNAL_ACTIONS; // the condition under test: never set
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
process.env.DEMO_ADMIN_EMAIL = "claudia@example.test";

const { default: handler, EXTERNAL_ACTIONS_ENABLED } = await import("../api/approve-action.js");

// Sprint 16 — intercept only the Supabase Auth check; everything else
// (the real loopback dummy server above) goes through the real fetch.
const realFetch = globalThis.fetch;
global.fetch = async (url, init) => {
  if (String(url).endsWith("/auth/v1/user")) {
    const token = /^Bearer\s+(.+)$/i.exec(init.headers.Authorization || "")?.[1];
    return token === "valid-admin-token"
      ? Response.json({ id: "user-claudia-uuid", email: "claudia@example.test" })
      : new Response("unauthorized", { status: 401 });
  }
  return realFetch(url, init);
};

function callHandler(body) {
  return new Promise((resolve, reject) => {
    const req = { method: "POST", headers: { origin: TEST_ORIGIN, authorization: "Bearer valid-admin-token" }, socket: {}, body };
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

test("EXTERNAL_ACTIONS_ENABLED is false when ENABLE_EXTERNAL_ACTIONS is unset", () => {
  assert.equal(EXTERNAL_ACTIONS_ENABLED, false);
});

test("a fully valid webhook config is not enough on its own: no network call, safe logged response", async () => {
  const { statusCode, body } = await callHandler({
    accountId: "ACC-01", action: "Call the customer.", category: "risk_mitigation", rationale: "x",
  });
  assert.equal(statusCode, 200);
  assert.deepEqual(body, { status: "logged", workflowConnected: false });
  assert.equal(requestCount, 0, "the dummy webhook server must never have been called");
});

after(() => new Promise(resolve => dummyServer.close(resolve)));
