import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dataset = JSON.parse(readFileSync(new URL("../data/accounts.json", import.meta.url), "utf8"));
const account = dataset.accounts[0];
const signalId = "da115850-8b4b-4aab-8e13-2e688991942a";
const signal = { signalId, type: "risk", reviewStatus: "pending", healthDelta: -5 };
let reviewStatus = "pending";
let claims = 0;

process.env.ACCOUNT_DATA_SOURCE = "supabase";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SECRET_KEY = "test-server-key";
process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
process.env.DEMO_ADMIN_EMAIL = "claudia@example.test";
process.env.ALLOWED_ORIGINS = "http://localhost:test";
process.env.ENABLE_EXTERNAL_ACTIONS = "false";
delete process.env.N8N_APPROVAL_WEBHOOK_URL;
const { default: handler } = await import("../api/approve-action.js");

global.fetch = async (url, init) => {
  if (String(url).endsWith("/auth/v1/user")) {
    const token = /^Bearer\s+(.+)$/i.exec(init.headers.Authorization || "")?.[1];
    return token === "valid-admin-token"
      ? Response.json({ id: "user-claudia-uuid", email: "claudia@example.test" })
      : new Response("unauthorized", { status: 401 });
  }
  if (String(url).endsWith("/rpc/hub_account_dataset")) {
    return Response.json({ ...dataset, accounts: dataset.accounts.map(a => a.accountId === account.accountId
      ? { ...a, customerSignals: [{ ...signal, reviewStatus }] } : a) });
  }
  if (String(url).includes("/customer_signals") && init.method === "PATCH") {
    const changes = JSON.parse(init.body);
    if (String(url).includes("review_status=eq.pending") && reviewStatus === "pending") {
      claims++;
      reviewStatus = changes.review_status;
      return Response.json([{ signal_id: signalId }]);
    }
    if (String(url).includes("review_status=eq.claimed") && reviewStatus === "claimed") {
      reviewStatus = changes.review_status;
      return Response.json([{ signal_id: signalId }]);
    }
    return Response.json([]);
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

test("signal review uses the existing endpoint, persists one claim, and rejects repeat approval", async () => {
  const body = { accountId: account.accountId, signalId, action: "Call the customer about the outage.",
    category: "risk_mitigation", rationale: "The customer reports blocked orders." };
  const first = await call(body);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "logged");
  assert.equal(reviewStatus, "logged");
  assert.equal(claims, 1);
  const second = await call(body);
  assert.equal(second.status, 409);
  assert.equal(claims, 1);
});

test("Gate 2 (signal-based review) rejects an unauthenticated call with 401, before any claim is attempted", async () => {
  const claimsBefore = claims;
  const result = await call(
    { accountId: account.accountId, signalId, action: "x", category: "risk_mitigation", rationale: "x" },
    null,
  );
  assert.equal(result.status, 401);
  assert.equal(claims, claimsBefore);
});
