# Sprint 15C: Email Signal Ingestion — Final Status

**Date:** 2026-09-29
**Status:** ✅ Complete, end-to-end tested

## Summary

A new n8n workflow ("Email Signal Ingestion") classifies incoming customer emails via AI and feeds them into the existing Customer Signal Intelligence pipeline (Supabase + Hub UI + Human Approval), reusing all Sprint 15C foundation work without modification.

## Architecture

```
Gmail Trigger (new message)
    -> Get a message (fetch full body)
    -> Format Request (build AI prompt from email)
    -> Message a model (OpenAI gpt-5-mini classification)
    -> Validate Response (strict enum/length checks)
    -> If (valid?)
        -> true: HTTP Request -> Supabase Edge Function (customer-signal-ingress)
            -> Handle Success (log outcome)
        -> false: Handle Validation Error (log outcome)
```

Workflow file: `n8n/email-signal-ingestion.workflow.json` (credentials and secrets stripped — see placeholders).

## End-to-end test result (risk signal)

**Input:** Real email sent to the monitored test inbox, describing an API outage.

**Result:**
- AI correctly classified: `signalType: risk`, `urgency: high`, `sentiment: negative`
- Sender matched to `ACC-01` (Alpenbank AG) via `account_contacts` lookup — no AI guessing of account identity
- Signal persisted in `customer_signals` with `health_delta: -10`
- Hub displayed the signal with base score (58) and effective score (48) shown separately
- CSM reviewed, edited, and approved the suggested action in the Hub UI
- Approval was claimed atomically (`pending` -> `claimed`, prevents double-review)
- Existing n8n Approval workflow (unchanged from earlier sprints) fired successfully:
  - Google Sheets row appended with full audit detail
  - Gmail message sent (`[Action approved] risk_mitigation · Alpenbank AG`) with clean HTML formatting, customer name, CSM name, account ID, action, and rationale — no template placeholders
- `review_status` in the database transitioned to `sent`

## Issues found and resolved during implementation

1. **Google OAuth blocks new test accounts** — the n8n OAuth app is unverified; only pre-approved test users (or the app's own creator) can authorize a new Gmail credential. Since we had no access to the STARTPLATZ Google Cloud Console to add a test user, we used an already-authorized test mailbox instead. The `source_mailbox` database constraint was updated accordingly via migration `20260930090000_update_source_mailbox_to_test_account.sql`.

2. **Node name references** — the Validate Response node referenced a prior node by its default name (`Code`); had to be corrected after renaming nodes for clarity (`Format Request`).

3. **OpenAI response format mismatch** — the OpenAI node in this n8n version returns the newer "Responses API" shape (`output[0].content[0].text`), not the classic chat-completions shape assumed initially. Parsing logic was corrected.

4. **JSON body null-handling bug** — when using per-field expressions in the HTTP Request body, a JavaScript `null` value gets serialized as the literal string `"null"`, which the Edge Function's strict validation rejects (it requires the `proposedAction`/`proposedRationale` keys to be entirely absent for routine signals, not present-as-null). Fixed by switching the HTTP Request body to a single JS-expression mode that conditionally omits those keys.

5. **Stale server process** — the local dev server had been running since the previous day and held outdated environment variables in memory (Node only reads `.env` at startup). A restart resolved a false "pending" review status despite a confirmed-success API response.

6. **Gmail field casing** — the Gmail "Get a message" node (Simplify mode) returns headers as `From`/`Subject` (capitalized), not `from`/`subject` — a case-sensitive JavaScript bug in the initial Format Request code.

## Security notes

- The exported workflow JSON in the repo has all credential IDs and the Supabase ingress token replaced with placeholders.
- **The ingress token used during testing was exposed in a local file download (`~/Downloads/*.json`) outside the repo.** This token should be rotated in Supabase Secrets + the n8n HTTP Request node before any further use, since it briefly existed in a file not covered by `.gitignore`.
- No customer email content is stored long-term — only the AI-classified summary/evidence excerpt (max 300 chars) per the existing schema constraints.

## Test coverage

All 230 existing automated tests continue to pass (`npm test`). No new automated tests were added for the n8n workflow itself (n8n workflows are not covered by the Node test suite — verification was manual, end-to-end, against the real Supabase instance).

## Files changed this session

- `supabase/migrations/20260930090000_update_source_mailbox_to_test_account.sql` (new)
- `n8n/email-signal-ingestion.workflow.json` (new — cleaned workflow export)
- `docs/15C_email_ingestion_payload_schema.md` (new)
- `docs/15C_workflow_c_structure.md` (new)
- `docs/15C_workflow_c_import_guide.md` (new)
- `docs/15C_workflow_c_build_steps.md` (new)
- `docs/15C_setup_handoff.md` (new)
- `docs/15C_final_status.md` (this file, new)
- `supabase/seeds/20260929_account_contacts_demo.sql` (updated: test sender mapping corrected to a real, reachable address)

## Open follow-ups (not blocking)

- Rotate the Supabase ingress token (see Security notes above).
- Consider adding automated coverage for the n8n workflow logic itself (e.g. exporting the Format Request / Validate Response code as testable Node modules), if this pipeline becomes permanent rather than a demo.
