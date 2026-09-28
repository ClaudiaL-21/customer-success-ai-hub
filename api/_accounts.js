import { readFile } from "node:fs/promises";

const seedUrl = new URL("../data/accounts.json", import.meta.url);

export class AccountDataError extends Error {
  constructor() {
    super("Account data is currently unavailable. Please try again.");
    this.name = "AccountDataError";
  }
}

export function accountDataSource() {
  const source = process.env.ACCOUNT_DATA_SOURCE || "json";
  if (!["json", "supabase"].includes(source)) throw new AccountDataError();
  return source;
}

function validateDataset(data) {
  if (!data || !Array.isArray(data.accounts) || !Array.isArray(data.csms)) throw new AccountDataError();
  if (data.accounts.length === 0 || data.csms.length === 0) throw new AccountDataError();
  const csmIds = new Set(data.csms.map(c => c?.csmId));
  const accountIds = new Set(data.accounts.map(a => a?.accountId));
  if (csmIds.size !== data.csms.length || accountIds.size !== data.accounts.length) throw new AccountDataError();
  for (const csm of data.csms) {
    if (typeof csm?.csmId !== "string" || typeof csm.name !== "string") throw new AccountDataError();
  }
  for (const account of data.accounts) {
    if (typeof account?.accountId !== "string" || typeof account.accountName !== "string"
      || !csmIds.has(account.csmId) || !account.contract || !account.usage
      || !account.support || !account.relationship || !Array.isArray(account.freeTextArtifacts)) {
      throw new AccountDataError();
    }
  }
  return data;
}

// One fresh, transaction-consistent snapshot per request. No module-global
// account cache and no silent fallback to stale JSON after a database error.
export async function loadAccountDataset() {
  try {
    if (accountDataSource() === "json") {
      return validateDataset(JSON.parse(await readFile(seedUrl, "utf8")));
    }
    const endpoint = new URL(process.env.SUPABASE_URL || "");
    const key = process.env.SUPABASE_SECRET_KEY;
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password
      || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || !key) throw new AccountDataError();
    const headers = { apikey: key, "Content-Type": "application/json" };
    // Legacy service-role JWTs also work; new secret keys belong in apikey only.
    if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
    const response = await fetch(new URL("/rest/v1/rpc/hub_account_dataset", endpoint), {
      method: "POST", headers, body: "{}", redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new AccountDataError();
    return validateDataset(await response.json());
  } catch {
    // Never expose upstream response bodies, URLs, or credentials.
    throw new AccountDataError();
  }
}
