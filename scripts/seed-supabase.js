// One-time, additive import of the original fictional portfolio. Existing
// database rows are deliberately left untouched on repeated runs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataset = JSON.parse(readFileSync(join(root, "data", "accounts.json"), "utf8"));
const chunkSize = 4;
const batchCount = Math.ceil(dataset.accounts.length / chunkSize);

function sqlJson(value) {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

export function seedSql(batch) {
  if (!Number.isInteger(batch) || batch < 0 || batch >= batchCount) throw new Error("Invalid seed batch");
  const statements = ["begin;"];
  if (batch === 0) {
    const { csms, accounts, ...metadata } = dataset;
    statements.push(`insert into public.dataset_metadata(id, data) values ('hub', ${sqlJson(metadata)}) on conflict (id) do nothing;`);
    statements.push(`insert into public.csms(csm_id, source_order, data) values
${csms.map((csm, index) => `('${csm.csmId}', ${index}, ${sqlJson(csm)})`).join(",\n")}
on conflict (csm_id) do nothing;`);
  }
  const start = batch * chunkSize;
  statements.push(`insert into public.accounts(account_id, csm_id, source_order, data) values
${dataset.accounts.slice(start, start + chunkSize).map((account, offset) =>
    `('${account.accountId}', '${account.csmId}', ${start + offset}, ${sqlJson(account)})`
  ).join(",\n")}
on conflict (account_id) do nothing;`);
  statements.push("commit;");
  return statements.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === "--batches") {
    process.stdout.write(String(batchCount));
  } else {
    process.stdout.write(seedSql(Number(process.argv[2])));
  }
}
