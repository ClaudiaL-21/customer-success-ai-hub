# Concept: Customer Intelligence Inbox & Case Lifecycle

**Status: APPROVED BY PO with binding decisions (see below). Architecture only — no code changed, nothing committed or deployed yet.**

**Date:** 2026-09-29 (updated after PO decision round)

## 0. What exists today (baseline)

Reviewed: `supabase/migrations/*`, `api/_accounts.js`, `api/_signal-store.js`, `api/approve-action.js`, `src/app.js` (renderCustomerSignals, view routing), `src/scoring.js` (computeHealthScore), `tests/customer-signal-*.test.js`.

- **`account_contacts`**: exact-match email → account_id lookup table. Deterministic, no AI involved.
- **`customer_signals`**: one row per classified inbound email. Fields include `match_status` (matched/unknown/ambiguous), `account_id` (set only when matched), `signal_type` (risk/growth/routine), `health_delta`, `review_status` (pending/claimed/logged/sent/uncertain), `reviewed_*` fields.
- **`hub_ingest_customer_signal()`**: SQL function called by the n8n Edge Function. Does the exact-match lookup and inserts the row. Signals with `account_id IS NULL` (unknown/ambiguous senders) are never surfaced to the Hub today — first gap the Inbox closes.
- **`computeHealthScore()`** (`src/scoring.js`): base 8-factor score untouched. A separate "strongest matched risk signal wins" adjustment subtracts up to 10 points.
- **`approve-action.js` + `_signal-store.js`**: the existing, working Human-in-the-Loop *action* approval gate (Gate 2). Reused unchanged.
- **UI**: `renderCustomerSignals()` renders signals inside an account's detail view only; no cross-account inbox exists yet. Tab-based view router (`state.view`) already exists for Portfolio/Matrix/Map/Team/QBRs/Feedback/Trust.
- **n8n Email Signal Ingestion workflow** (Sprint 15C): classifies risk/growth/routine + urgency/sentiment/summary/evidence + one proposed action. Does not capture Gmail `threadId`, does not classify into 4 inbound categories, produces only a flat action string.

---

## PO Decisions (binding, this round)

1. **Confirmation scope**: *every new signal* (from this feature onward) requires a confirmed account link before it can affect Health or produce an NBA — **including exact e-mail matches**, which are now treated as high-confidence *suggestions*, not automatic truth. **Historical Sprint-15C data is never retroactively changed** — existing rows keep affecting health exactly as they do today. A signal that is a reply within an **already-confirmed Gmail thread** may automatically inherit that thread's confirmed account/case **if nothing contradicts it** (see §A.2).
2. **Multi-stage account suggestion**, in order of confidence: (1) known contact — exact match, (2) verified domain — curated, human-maintained domain→account table, (3) company name/alias found in the mail body or signature — AI-extracted. **The AI only ever returns a suggestion + the evidence text it based it on — it never invents or assigns an account ID itself.** Matching the extracted name/alias to an actual `account_id` is a deterministic server-side lookup, never an AI decision.
3. **Curated documentation allowlist**, starting small. No invented URLs, ever. If nothing in the allowlist matches, the AI **must say so explicitly** (a "no matching documentation found" signal), not silently omit it.
4. **Gmail thread-based case linking**: a reply within the *same* `thread_id` as an already-confirmed case may inherit that case. A *different* thread with similar characteristics (same account, same category) is **only ever a merge suggestion for the CSM to accept** — same account + same category alone is explicitly **not sufficient** for anything automatic.

**Additional binding constraints:**
- Inbox shows all valid signals, including unknown/ambiguous.
- History is preserved (nothing is ever deleted or silently overwritten).
- A Case ID is for internal traceability only — **this is explicitly not a ticketing system**: no SLAs, no assignee workflows, no priority engine. Just a lifecycle status and its linked signals.
- A routine email does not require a durable case.
- Two separate gates: Confirm Account/Case, and Review Action.
- Health considers only confirmed, active risk cases.
- Resolved removes the risk deduction; Reopened reactivates it.
- The existing 8-factor scoring model is unchanged.
- The existing Approval workflow is reused as-is.
- **Three distinct status fields must never be conflated** (see §A.6 for the explicit contrast).

---

## A. Proposed data model and required migrations

Guiding principle unchanged: **additive only**. Existing rows, existing tests, and the already-shipped Sprint 15C flow keep working exactly as today with zero behavior change from Package 1 (schema-only) — the *behavior* changes only arrive in Package 5, when the ingestion path itself is updated to apply the new, stricter confirmation rule to newly-created signals.

### A.1 New table: `cases`

```sql
create table public.cases (
  case_id uuid primary key default gen_random_uuid(),
  account_id text references public.accounts(account_id),        -- nullable until account is confirmed
  title text not null check (length(title) between 1 and 150),
  inbound_category text not null check (inbound_category in
    ('information_enablement','collaboration_requests','feedback_issues','account_development_change')),
  status text not null default 'needs_review' check (status in
    ('needs_review','open','monitoring','resolved','reopened')),
  opened_by_csm_id text references public.csms(csm_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  reopened_count integer not null default 0
);
```

Explicitly **not** a ticketing system: no SLA/due-date fields, no assignee, no priority field beyond what already exists on the linked signal (risk/growth/routine + urgency). This is deliberate, per PO decision.

RLS: same lockdown pattern as `customer_signals` — `service_role` only.

### A.2 New table: `verified_account_domains` (curated, stage 2 of the suggestion ladder)

```sql
create table public.verified_account_domains (
  domain text primary key check (domain = lower(btrim(domain))),
  account_id text not null references public.accounts(account_id),
  added_by_csm_id text references public.csms(csm_id),
  added_at timestamptz not null default now()
);
```

Manually curated (a CSM adds "alpenbank.com → ACC-01" once, confidently, for a known customer domain that isn't in `account_contacts` contact-by-contact). Never populated by AI.

### A.3 Extend `customer_signals`

```sql
alter table public.customer_signals
  add column thread_id text,                              -- Gmail threadId, for same-conversation inheritance
  add column inbound_category text check (inbound_category in
    ('information_enablement','collaboration_requests','feedback_issues','account_development_change')),
  add column suggestion_source text check (suggestion_source in
    ('contact_match','verified_domain','name_alias_match','thread_inherited')),
  add column suggested_account_id text references public.accounts(account_id),  -- AI/lookup guess, never authoritative alone
  add column suggestion_evidence text check (suggestion_evidence is null or length(suggestion_evidence) between 1 and 500),
  add column account_confirmed boolean not null default true,   -- see note below: default true is what preserves history
  add column confirmed_account_id text references public.accounts(account_id), -- set only by a human, or inherited per §4
  add column confirmed_by_csm_id text references public.csms(csm_id),
  add column confirmed_at timestamptz,
  add column case_id uuid references public.cases(case_id),
  add column processing_status text not null default 'needs_review' check (processing_status in
    ('needs_review','triaged','actioned','archived')),
  add column action_type text check (action_type in
    ('documentation','reply_draft','follow_up_question','meeting_prep','escalation')),
  add column action_sources jsonb not null default '[]'::jsonb,
  add column no_matching_source_found boolean not null default false;
```

**Why `account_confirmed default true`, given PO decision 1 says new signals must be confirmed?** This column default governs *existing rows* at migration time (Package 1, schema-only) — they all become `account_confirmed = true`, which exactly matches "no retroactive change to historical Sprint-15C data": their `account_id` keeps affecting health exactly as it does today, with zero behavior change. The *stricter rule for new signals* — every new signal starts at `account_confirmed = false` regardless of match confidence, until a human confirms it — is applied by the **ingestion code path itself** (Package 5), not by the column default. This is the cleanest way to satisfy "no retroactive change" and "all new signals need confirmation" simultaneously without two different schemas.

**Thread inheritance (PO decision 1, second sentence):** when a new signal's `thread_id` matches an existing signal that already has `confirmed_account_id` set, the ingestion path may set `confirmed_account_id`/`case_id` immediately (`suggestion_source = 'thread_inherited'`, `account_confirmed = true`) **only if there is no contradiction** — concretely: the new sender is either the same sender as the confirmed prior message, or is a `contact_match`/`verified_domain` hit pointing at the *same* account. If the new sender contradicts the confirmed account (e.g. resolves to a *different* account via contact/domain match), inheritance is skipped and it falls back to a normal, human-reviewed suggestion instead — never a silent override.

### A.4 Multi-stage suggestion ladder (PO decision 2) — precise algorithm for Package 5

For every new inbound signal, in order, stop at the first hit:

1. **`contact_match`**: exact `account_contacts` lookup (existing `hub_ingest_customer_signal()` logic, unchanged as a lookup — only its *effect* changes, see §A.3).
2. **`verified_domain`**: sender's email domain found in `verified_account_domains`.
3. **`name_alias_match`**: the AI is given the email body/signature and asked to extract *only* a company name/alias string and a short evidence quote — **never an account ID**. The server then does a deterministic string match (exact or normalized fuzzy match, e.g. case/whitespace-insensitive) of that extracted name against known `account.accountName` values (and an optional alias list, if one exists). If no confident match, `suggested_account_id` stays `null` — the signal is `Unassigned`, never guessed.

In every case, `suggested_account_id` + `suggestion_source` + `suggestion_evidence` are populated; `confirmed_account_id`/`account_confirmed` stay untouched until a human acts (Gate 1), except for the thread-inheritance case in §A.2.

### A.5 Documentation allowlist enforcement (PO decision 3)

```sql
create table public.approved_doc_sources (
  url text primary key,
  title text not null,
  added_by_csm_id text references public.csms(csm_id),
  added_at timestamptz not null default now()
);
```

Server-side (Edge Function or ingestion path) validates every AI-proposed source URL against this table before it ever reaches `action_sources`. Any URL not on the list is dropped. If the AI's proposed action was `documentation`-type but it found no valid allowlisted source, `no_matching_source_found` is set to `true` and the CSM-facing UI shows this explicitly (e.g. "No matching internal documentation found — a manual reply may be needed") rather than silently showing nothing. Starting allowlist can be empty — that is a safe, honest default (no AI ever shows links until the team curates the table).

### A.6 Three status fields — explicit, never to be conflated

| Field | Table | Values | Answers |
|---|---|---|---|
| `processing_status` | `customer_signals` | needs_review → triaged → actioned → archived | "How far along is *this individual signal* in Inbox triage?" |
| `status` | `cases` | needs_review → open → monitoring → resolved → reopened | "What is the lifecycle state of the *overall case* (which may span several signals)?" |
| `review_status` | `customer_signals` (existing, Sprint 15C, unchanged) | pending → claimed → logged/sent/uncertain | "Has the *proposed action* (NBA) for this signal been reviewed and approved?" (Gate 2) |

A single signal can be, for example, `processing_status = triaged`, belong to a `case` with `status = open`, while its own `review_status` is still `pending` — these three are independent and must be shown as separate, clearly labeled fields in the UI, never merged into one "status" badge.

### A.7 Health score integration (no change to the 8-factor base)

Extended predicate in `computeHealthScore`'s existing "strongest matched risk signal" filter: a signal counts only if `account_confirmed = true` **and** (its `case_id` is null, **or** the linked case's `status` is not `resolved`). A `reopened` case makes its signals count again automatically — same query, no special-case code, since `reopened` is simply not `resolved`. The row and its `health_delta` are never modified — only the live scoring query's filter changes.

### A.8 `hub_account_dataset()` and a new `hub_inbox_dataset()`

`hub_account_dataset()` gains the new fields per signal (additive JSON, backward compatible). A **new** `hub_inbox_dataset(csm_id_filter text default null)` function returns a flat, cross-account list — including `account_id is null` (unassigned/unknown/ambiguous) signals that the per-account function structurally cannot surface — with denormalized account/CSM names to avoid N+1 lookups in the UI.

---

## B. Inbox and Case UI concept

New tab (`state.view = "inbox"`) in the existing view router, alongside Portfolio/Matrix/Map/Team/QBRs/Feedback/Trust.

### B.1 Inbox list view

One row per signal (visual language reused from `nba-box`/`nba-box-risk`):
- Sender, subject/topic, received time
- Account column: confirmed account name; or "Suggested: {name} ({suggestion_source}) — {evidence}" with inline Confirm/Correct; or "Unassigned"
- Inbound category badge (1 of 4)
- Risk/Growth/Routine badge
- **Three separate status badges** per §A.6 — processing status, case status (if linked), action review status (if an NBA exists) — never merged
- Case link, if any

### B.2 Filters

My Accounts / Unassigned / All (scope) · Account (confirmed accounts only) · Category (4) · Risk/Growth/Routine · Processing status. Extends the existing `state.filters` object mechanism used by Portfolio today.

### B.3 Case detail view

Metadata, chronological signal timeline (message-id, thread-id, timestamp, excerpt), lifecycle control (valid-transition-only, not a free dropdown — resolved can only be reached from open/monitoring, reopened only from resolved), and a **"Similar cases" panel** that is always suggestion-only (§B.4). Explicitly no SLA fields, no assignee, no priority field of its own — case = traceability, not a ticket.

### B.4 Similar-case suggestions (PO decision 4)

Two distinct mechanisms, never conflated:
- **Same-thread inheritance**: automatic (per §A.2), because it's the *same conversation*, not a guess.
- **Cross-thread similarity**: always a suggestion the CSM must explicitly accept via "Link to this case" — same account + same category is **necessary but not sufficient** to even surface a candidate (per PO decision 4's explicit "allein reichen nicht"); v1 heuristic: same confirmed account + same category + case not resolved + (topic/summary text overlap above a simple threshold, e.g. shared keywords) — no embedding/AI similarity needed for v1, upgradeable later without a schema change (§F.5 in the prior round, still valid).

### B.5 The two Human-in-the-Loop gates, concretely

- **Gate 1 — Confirm Account/Case**: shown whenever `account_confirmed = false`. Compact control: "Suggested: {account} via {source} — '{evidence}' — [Confirm] [Choose different ▾]", plus "Link to case ▾ / Start new case / No case needed" (routine mail).
- **Gate 2 — Review & Approve Action**: unchanged, exactly the existing `renderApprovalControl`/`approve-action.js`/`_signal-store.js` flow, now reachable from the Inbox too (second call site, same component).

---

## C. Reuse of existing components

| New need | Existing component reused |
|---|---|
| Signal card visuals | `nba-box` / `nba-box-risk` CSS, `escapeHtml`, `fmtDateTime` |
| Gate 2 (action approval) | `renderApprovalControl`, `ai.js`'s `approveAction()`, `approve-action.js`, `_signal-store.js`'s atomic-claim pattern |
| Tab/view routing | `state.view`, `render()`'s tab toggling |
| Filter bar mechanics | `state.filters`, existing dropdown-filter wiring |
| Server-side strict validation | `validateSignalPayload()` style enum/length checks, extended for new fields |
| Atomic single-claim pattern | `patchSignal()` conditional-update pattern, reused for Gate 1 |
| Health score computation | `computeHealthScore()` — predicate extended, not replaced |
| RLS/security posture | Same `service_role`-only lockdown |
| AI credential for name/alias extraction and doc-source matching | Same OpenAI credential already used in the n8n classification step — no new AI integration point |

---

## D. Implementation order — small, testable packages

1. **Schema only**: `cases`, `verified_account_domains`, `approved_doc_sources` tables + `customer_signals` new columns (all with the defaults from §A.3–A.5). Zero app-code change, zero behavior change — existing 230 tests stay green untouched. **← This is the package detailed and shown for approval next, per your instruction.**
2. **`hub_account_dataset()` + new `hub_inbox_dataset()`**: additive SQL only, no frontend change yet.
3. **Backend: Gate 1 endpoint** (`api/confirm-signal-account.js`) — atomic confirm/correct, optional case link/create in one transaction. Unit-tested with mocked `fetch`, same style as `customer-signal-review.test.js`.
4. **`computeHealthScore()` extension**: the §A.7 predicate. Existing tests must pass byte-for-byte unmodified (no test fixture has a case yet); new tests added alongside.
5. **n8n workflow extension**: capture `threadId`, classify into 4 categories, structured `action_type` + sourced/flagged documentation, and the 3-stage account-suggestion ladder (§A.4) for signals with no exact contact match. Also where the new ingestion path starts setting `account_confirmed = false` for genuinely new signals (per §A.3) and applies thread-inheritance (§A.2). n8n-only + Edge Function payload-validation change — no frontend impact yet.
6. **Frontend: Inbox view, read-only first** (list + filters, no gates wired) — verify data model/filters visually before wiring actions.
7. **Frontend: Gate 1 UI** wired to package 3.
8. **Frontend: Gate 2 reuse** — point existing `renderApprovalControl` at Inbox-sourced signals too.
9. **Case detail view, lifecycle transitions, similar-case suggestions (§B.4).**
10. **Full regression pass + end-to-end manual test** (real email → 3-stage suggestion → confirm → approve action → verify Sheet/Gmail/Hub), mirroring how Sprint 15C's own end-to-end test was done.

Packages 1–5 touch no existing UI at all. Packages 6–9 are additive (new tab); existing Portfolio/Matrix/Map/etc. views are never touched.

---

## E. Impact on existing data and regression tests

- Existing `customer_signals` rows: `account_confirmed` defaults to `true` at migration time — **explicitly preserves current health-affecting behavior with zero backfill logic needed**, satisfying "no retroactive change to historical Sprint-15C data" exactly.
- `computeHealthScore()` tests: must pass byte-for-byte unmodified — no current fixture has a `case_id`, so the new predicate is a no-op for all of them.
- `customer-signal-review.test.js` / `customer-signal-ingress.test.js`: unaffected — Gate 2 and ingress validation untouched by Package 1.
- `hub_account_dataset()` change (Package 2): additive JSON fields only.
- RLS: new tables inherit the same restrictive, `service_role`-only posture as `customer_signals`/`account_contacts` — no existing grant loosened.

---

## F. Remaining risks / notes (informational, no open decisions left blocking Package 1)

- The 3-stage suggestion ladder's fuzzy name-matching (stage 3) needs a concrete normalization rule (case/whitespace, maybe punctuation) — a Package 5 implementation detail, not a schema concern.
- `verified_account_domains` starts empty; stage 2 of the ladder simply never fires until curated — safe default.
- `approved_doc_sources` starts empty; §A.5's `no_matching_source_found` flag makes that gap visible rather than silently hidden.
- Case similarity heuristic (§B.4) is intentionally simple for v1 (no embeddings) and upgradeable later without another migration, since the comparison happens in application/SQL logic, not stored.

---

## Summary

All four PO decisions are now reflected directly in the schema (§A) and UI concept (§B), with the historical-data guarantee satisfied via the `account_confirmed default true` migration-time semantics (§A.3) rather than any retroactive row-by-row change. Package 1 (schema-only) is next — shown in full before being run, per your instruction, with nothing deployed and no existing workflow touched.
