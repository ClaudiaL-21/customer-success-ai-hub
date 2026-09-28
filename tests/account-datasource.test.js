import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadAccountDataset } from "../api/_accounts.js";
import accountsHandler from "../api/accounts.js";

const originalSource = process.env.ACCOUNT_DATA_SOURCE;
const originalUrl = process.env.SUPABASE_URL;
const originalKey = process.env.SUPABASE_SECRET_KEY;
const originalFetch = globalThis.fetch;
const fixture = JSON.parse(readFileSync(new URL("../data/accounts.json", import.meta.url), "utf8"));

function restore() {
  if (originalSource === undefined) delete process.env.ACCOUNT_DATA_SOURCE;
  else process.env.ACCOUNT_DATA_SOURCE = originalSource;
  if (originalUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.SUPABASE_SECRET_KEY;
  else process.env.SUPABASE_SECRET_KEY = originalKey;
  globalThis.fetch = originalFetch;
}

test("Supabase dataset preserves every seeded account and CSM field", async () => {
  try {
    process.env.ACCOUNT_DATA_SOURCE = "supabase";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "sb_secret_test_only";
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), "https://example.supabase.co/rest/v1/rpc/hub_account_dataset");
      assert.equal(options.headers.apikey, "sb_secret_test_only");
      assert.equal(options.method, "POST");
      return { ok: true, json: async () => structuredClone(fixture) };
    };
    assert.deepEqual(await loadAccountDataset(), fixture);
  } finally { restore(); }
});

test("database failure does not show a stale JSON portfolio", async () => {
  try {
    process.env.ACCOUNT_DATA_SOURCE = "supabase";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "sb_secret_test_only";
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    const result = { statusCode: 200, status(n) { this.statusCode = n; return this; }, setHeader() {}, json(value) { this.body = value; return this; } };
    await accountsHandler({ method: "GET" }, result);
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.accounts, undefined);
    assert.ok(!JSON.stringify(result.body).includes("sb_secret_"));
  } finally { restore(); }
});

test("unseeded database does not look like an empty customer portfolio", async () => {
  try {
    process.env.ACCOUNT_DATA_SOURCE = "supabase";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "sb_secret_test_only";
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ accounts: [], csms: [] }) });
    await assert.rejects(loadAccountDataset(), { name: "AccountDataError" });
  } finally { restore(); }
});

test("account endpoint rejects writes", async () => {
  const result = { statusCode: 200, status(n) { this.statusCode = n; return this; }, setHeader() {}, json(value) { this.body = value; return this; } };
  await accountsHandler({ method: "POST" }, result);
  assert.equal(result.statusCode, 405);
});
