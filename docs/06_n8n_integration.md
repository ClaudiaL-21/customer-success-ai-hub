# n8n Integration

Two independent integration points. Both are optional — the app works fully without either (mock mode, or direct Anthropic/OpenAI calls, and locally-logged approvals). Wire whichever fits your course project.

## Authentication (both integration points)

As of Sprint 03, **every outbound call to n8n carries a shared-secret header**: `x-cs-ai-hub-secret`, value taken from `N8N_WEBHOOK_SECRET` in `.env`. Your n8n workflow must authenticate the Webhook trigger node with a **Header Auth** credential expecting that exact header name and value — see `docs/11_n8n_hardening_runbook.md` for the click-by-click setup.

If a webhook URL (`N8N_ANALYZE_WEBHOOK_URL` or `N8N_APPROVAL_WEBHOOK_URL`) is set but `N8N_WEBHOOK_SECRET` is missing, the app refuses to call it — no external request is made, and the app returns a clear, secret-free configuration error instead. The secret itself is never logged and never sent to the browser.

Both calls also carry a timeout (the analyze call gets more time than the approval call, since an LLM response can be slow — see `.env.example` for the current defaults and how to override them). The approval call is **never automatically retried** on failure, because a silent retry without idempotency could append a duplicate Sheet row and send a duplicate internal email for the same approval.

## A. n8n as the AI compute layer

Lets n8n's own AI connection do the actual analysis, instead of `api/analyze.js` calling Anthropic/OpenAI directly. Useful if your working AI credentials/credits live in n8n.

**Setup:**
1. In `.env`, set `AI_PROVIDER=n8n`, `N8N_ANALYZE_WEBHOOK_URL=<your webhook URL>`, and `N8N_WEBHOOK_SECRET=<a secret you choose>`.
2. In n8n, build: **Webhook** (POST, Header Auth) → your AI node (OpenAI/Anthropic/whatever you have working) → **Respond to Webhook**.

**Request we send to your webhook** (header `x-cs-ai-hub-secret: <your secret>`):
```json
{ "system": "<system prompt>", "user": "<user prompt with account context + JSON schema instructions>", "maxTokens": 600 }
```

**Response your workflow must return:**
```json
{ "text": "<the AI's raw text output, unmodified>" }
```
We parse `text` as JSON ourselves (same schema Anthropic/OpenAI would return directly) — your AI node inside n8n should be given the `system` and `user` fields as its system/user prompts respectively, and its raw output just gets passed through in `text`. The app rejects a response with a missing or empty `text` field, or with an unreachable workflow / a timeout, with a short, controlled, demo-safe error — it never silently treats a broken webhook as success.

## B. Human-Approval workflow

When a CSM reviews and confirms an AI-suggested Next Best Action (Sprint 02's Human Review step), this fires — independent of which AI provider generated the original suggestion. This is the app's core responsibility principle in action: AI proposes, a human reviews and confirms, only then does anything happen.

**Setup:**
1. In `.env`, set `N8N_APPROVAL_WEBHOOK_URL=<your webhook URL>` and `N8N_WEBHOOK_SECRET=<the same secret as above>`.
2. In n8n, build: **Webhook** (POST, Header Auth) → whatever you want to happen (Slack message, CRM task, log to a sheet, internal notification, etc.).

**Payload we send** (header `x-cs-ai-hub-secret: <your secret>`):
```json
{
  "accountId": "ACC-10",
  "accountName": "Benelux Mobility Group",
  "csmName": "Fiona Callahan",
  "action": "Call the customer and clarify the main open issue.",
  "category": "risk_mitigation",
  "rationale": "This is the top-weighted risk driver for this account right now.",
  "reviewedByHuman": true,
  "approvedAt": "2026-08-11T21:18:35.437Z"
}
```
`reviewedByHuman` is always `true` — this endpoint only ever fires after the CSM has explicitly reviewed and confirmed the action in the UI (see Sprint 02). No response body is required — any 2xx status is treated as success.

If `N8N_APPROVAL_WEBHOOK_URL` isn't set, approvals are still tracked in the UI ("✓ Reviewed by CSM and logged, no workflow connected yet") and logged server-side, so the flow is demoable without n8n. If the URL **is** set but `N8N_WEBHOOK_SECRET` is missing, that's treated as a misconfiguration (not the "no workflow wired up" case above) and the app returns a config error instead of calling an unauthenticated webhook.

**Sprint 15C Final Showcase Flow — `customerDraft` field:** for a signal-based review only (never the legacy on-demand NBA path), the payload above now also carries:
```json
{
  "customerDraft": {
    "senderEmail": "customer@example.com",
    "subject": "Re: Login-Ausfall / Zugriff nicht möglich",
    "body": "Hi, thanks for flagging this — we're investigating now and will follow up shortly."
  }
}
```
Present only when the originating signal has a stored `proposed_response` (risk/growth signals; see `docs/15C_email_ingestion_payload_schema.md`) — absent for the legacy on-demand NBA path and for any signal without one.

**Required manual step (not done by this repo's code — no n8n API access from here):** the Approval workflow's own Gmail node needs to be switched from **Send Email** to **Create Draft**, with To = `{{$json.customerDraft.senderEmail}}`, Subject = `{{$json.customerDraft.subject}}`, Body = `{{$json.customerDraft.body}}`. This keeps the existing internal notification/Sheet-logging step as-is (still fires on every approval) but adds the customer-facing draft as the flow's actual deliverable — the CSM reviews/edits/sends it from Gmail themselves; nothing here or in n8n sends it automatically.

**Anti-loop guard:** the same Gmail mailbox this workflow's internal notification lands in is also the one the Email Signal Ingestion workflow (`n8n/email-signal-ingestion.workflow.json`) monitors. That workflow now has a deterministic "Skip Internal Mail" IF node, right after fetching the message and before any AI classification, that stops the run for any Subject starting with `[Action approved]` (the notification's fixed, non-AI-generated prefix) — so the internal notification is never re-ingested as a new customer signal. This relies on that prefix staying fixed; changing it requires updating the guard's condition to match.

## Exported workflow files

Raw n8n workflow exports (as JSON) contain webhook path segments, credential references, Sheet IDs/URLs, and similar identifying details. **Do not commit a raw export into this repository.** If you want to check one in for reference, strip the `webhookId`/`path`/`id`/`credentials` fields and any Google Sheets document IDs/URLs and personal email addresses first.
