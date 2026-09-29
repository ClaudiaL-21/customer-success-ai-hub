import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest, validateSignalPayload } from "../supabase/functions/customer-signal-ingress/handler.js";

const token = "test-only-ingress-token-with-32-characters";
const env = { get: key => ({ CUSTOMER_SIGNAL_INGRESS_TOKEN: token, SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEYS: JSON.stringify({ default: "test-server-key" }) })[key] };
const payload = {
  messageId: "18cfa88bcf12345", senderEmail: "Demo Customer <demo@example.test>", topic: "Service outage",
  signalType: "risk", sentiment: "negative", urgency: "high", summary: "Customer reports an outage.",
  evidence: "We cannot complete orders.", classifier: "demo-model-v1",
  proposedAction: "CSM should review the outage and coordinate a response.", proposedRationale: "The customer reports blocked orders.",
};
const request = (body, supplied = token) => new Request("https://example.supabase.co/functions/v1/customer-signal-ingress", {
  method: "POST", headers: { "content-type": "application/json", "x-cs-signal-token": supplied }, body: JSON.stringify(body),
});

test("normalizes a sender without letting AI choose an account", () => {
  const result = validateSignalPayload(payload);
  assert.equal(result.senderEmail, "demo@example.test");
  assert.equal("accountId" in result, false);
  assert.equal(validateSignalPayload({ ...payload, accountId: "ACC-001" }), null);
});

test("rejects invalid categories, missing proposed actions, and raw email bodies", () => {
  assert.equal(validateSignalPayload({ ...payload, signalType: "critical" }), null);
  assert.equal(validateSignalPayload({ ...payload, proposedAction: "" }), null);
  assert.equal(validateSignalPayload({ ...payload, body: "raw mail" }), null);
});

test("unauthorized ingress never calls the database", async () => {
  let calls = 0;
  const response = await handleRequest(request(payload, "wrong"), env, async () => { calls++; });
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

test("authorized ingress forwards only normalized fields and returns no email content", async () => {
  let outgoing;
  const response = await handleRequest(request(payload), env, async (url, init) => {
    outgoing = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
    return Response.json({ signalId: "da115850-8b4b-4aab-8e13-2e688991942a", matchStatus: "matched", duplicate: false });
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { signalId: "da115850-8b4b-4aab-8e13-2e688991942a", matchStatus: "matched", duplicate: false });
  assert.match(outgoing.url, /hub_ingest_customer_signal$/);
  assert.equal(outgoing.body.payload.senderEmail, "demo@example.test");
  assert.equal(outgoing.headers.apikey, "test-server-key");
});
