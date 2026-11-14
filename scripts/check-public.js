#!/usr/bin/env node
// Pre-publish check for a public repository.
// Scans every tracked file (git ls-files) for private file names and private content.
// Usage: npm run check:public    Exit code 1 means findings, 0 means clean.
// Dependency-free on purpose, same as the dev server.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// File names that should never be tracked in this repository.
const PRIVATE_NAME_PATTERNS = [
  /bewerbung/i,
  /lebenslauf/i,
  /anschreiben/i,
  /(^|[\\/_-])(resume|cv)([\\/_.-]|$)/i,
  /gehalt/i,
  /beihilfe/i,
  /debeka/i,
  /application[_-]brief/i,
  /chatgpt/i,
  /(^|\/)\.env($|\.)(?!example)/i,
  /(^|\/)(private|notes|internal-notes)\//i,
  /\.(mp4|mov|m4v|heic)$/i,
];

// Content patterns. Each has a label for the report.
const CONTENT_PATTERNS = [
  { label: "email address", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, kind: "email" },
  { label: "phone number", re: /\+49[ \d()/-]{8,}/g },
  { label: "OpenAI/Anthropic-style key", re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { label: "JWT / Supabase key", re: /\beyJhbGciOi[A-Za-z0-9_-]{20,}/g },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { label: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { label: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { label: "employer / product name", re: /\bSAS CI360\b|\bSAS Institute\b/g },
  { label: "application wording", re: /Bewerbung bei|Gehaltsvorstellung|Stellenanzeige/g },
];

// Accepted findings. Keep this list short and explain every entry.
const ALLOWED_EMAILS = [
  /@example\.(com|org)$/i, // reserved documentation domains
  /\.test$/i, // reserved test TLD, fictional addresses
  /^democsaihub@gmail\.com$/i, // dedicated demo mailbox for the n8n flow
];
const ALLOWED_PATH_CONTENT = [
  // Already-applied Supabase migrations name the test mailbox. Editing them would
  // make the repo differ from the live database, so they stay as they are.
  { file: /^supabase\/migrations\//, re: /googlemail\.com/i },
];

const SKIP_FILES = /^scripts\/check-public\.js$|(^|\/)package-lock\.json$|\.(png|jpe?g|gif|webp|ico|pdf|pptx|woff2?)$/i;
const MAX_LINE = 2000; // skip inline base64 blobs (SVG logos etc.)

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

function isAllowed(file, finding, kind) {
  if (kind === "email" && ALLOWED_EMAILS.some((re) => re.test(finding))) return true;
  return ALLOWED_PATH_CONTENT.some((a) => a.file.test(file) && a.re.test(finding));
}

const findings = [];

for (const file of trackedFiles()) {
  for (const re of PRIVATE_NAME_PATTERNS) {
    if (re.test(file)) {
      findings.push({ file, line: 0, label: "private file name", text: file });
      break;
    }
  }
  if (SKIP_FILES.test(file)) continue;

  let content;
  try {
    content = fs.readFileSync(path.join(ROOT, file), "utf8");
  } catch {
    continue;
  }
  if (content.includes("\0")) continue; // binary

  content.split(/\r?\n/).forEach((line, i) => {
    if (line.length > MAX_LINE) return;
    for (const p of CONTENT_PATTERNS) {
      for (const m of line.matchAll(p.re)) {
        if (isAllowed(file, m[0], p.kind)) continue;
        findings.push({ file, line: i + 1, label: p.label, text: m[0] });
      }
    }
  });
}

if (findings.length === 0) {
  console.log("check:public OK. No private file names or private content found.");
  process.exit(0);
}

console.error(`check:public found ${findings.length} possible problem(s):\n`);
for (const f of findings) {
  const where = f.line ? `${f.file}:${f.line}` : f.file;
  console.error(`  [${f.label}] ${where}  ->  ${f.text}`);
}
console.error("\nFix these, or add a justified entry to the allowlist in scripts/check-public.js.");
process.exit(1);
