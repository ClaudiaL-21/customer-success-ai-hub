import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
process.env.ALLOWED_ORIGINS = "http://localhost:test";

const { default: handler } = await import("../api/login.js");

let lastRequest = null;

global.fetch = async (url, init) => {
  if (String(url).includes("/auth/v1/token?grant_type=password")) {
    lastRequest = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    if (init.body.includes("correct-password")) {
      return Response.json({ access_token: "real-session-token", token_type: "bearer" });
    }
    return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  }
  throw new Error(`Unexpected test request: ${url}`);
};

function call(body) {
  return new Promise((resolve, reject) => {
    const req = { method: "POST", headers: { origin: "http://localhost:test" }, socket: {}, body };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, setHeader() {},
      json(value) { resolve({ status: this.statusCode, body: value }); }, end() { resolve({ status: this.statusCode }); } };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test("valid credentials return an access token, and the service-role key is never used for this call", async () => {
  const result = await call({ email: "claudia@example.test", password: "correct-password" });
  assert.equal(result.status, 200);
  assert.equal(result.body.accessToken, "real-session-token");
  assert.equal(lastRequest.headers.apikey, "test-publishable-key");
});

test("wrong password returns a generic 401, never leaking the upstream error body", async () => {
  const result = await call({ email: "claudia@example.test", password: "wrong-password" });
  assert.equal(result.status, 401);
  assert.ok(!JSON.stringify(result.body).includes("invalid_grant"));
});

test("missing email/password is rejected with 400 before any network call", async () => {
  lastRequest = null;
  const result = await call({ email: "claudia@example.test" });
  assert.equal(result.status, 400);
  assert.equal(lastRequest, null);
});
