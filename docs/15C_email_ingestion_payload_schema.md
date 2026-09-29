# Sprint 15C: Email Signal Ingestion Payload Schema

## KI-Klassifikator Output (vom OpenAI Chat Model)

Die KI muss dieses JSON-Objekt zurückgeben. **Alle Felder sind erforderlich.** Die n8n Information Extractor oder Code-Node muss diese Struktur garantieren.

```json
{
  "topic": "string (1-100 chars, max)",
  "signalType": "risk" | "growth" | "routine",
  "sentiment": "positive" | "neutral" | "negative",
  "urgency": "low" | "medium" | "high",
  "summary": "string (1-500 chars)",
  "evidence": "string (1-300 chars, direct quote from email)",
  "classifier": "string (1-100 chars, e.g., 'gpt-5-mini-20260929')",
  "proposedAction": "string | null",
  "proposedRationale": "string | null"
}
```

### Bedingungen:

- **Wenn `signalType` = "risk" oder "growth":**
  - `proposedAction` MUSS ein non-empty String sein (1-700 chars)
  - `proposedRationale` MUSS ein non-empty String sein (1-500 chars)

- **Wenn `signalType` = "routine":**
  - `proposedAction` MUSS null sein
  - `proposedRationale` MUSS null sein

- Alle String-Felder werden trimmt (führend/nachfolgende Whitespace entfernt)

---

## n8n Validation Node (vor HTTP Request zu Supabase)

**Diese Checks müssen im n8n-Workflow laufen, bevor die Edge Function aufgerufen wird:**

```javascript
// Pseudocode für n8n Code Node

const ai_output = $json.ai_response;
const errors = [];

// 1. Enum validation
if (!["risk", "growth", "routine"].includes(ai_output.signalType)) {
  errors.push("signalType must be 'risk', 'growth', or 'routine'");
}
if (!["positive", "neutral", "negative"].includes(ai_output.sentiment)) {
  errors.push("sentiment must be one of: positive, neutral, negative");
}
if (!["low", "medium", "high"].includes(ai_output.urgency)) {
  errors.push("urgency must be one of: low, medium, high");
}

// 2. String length validation
const limits = { topic: 100, summary: 500, evidence: 300, classifier: 100, proposedAction: 700, proposedRationale: 500 };
for (const [field, max] of Object.entries(limits)) {
  const val = (ai_output[field] || "").trim();
  if (val.length > max) {
    errors.push(`${field} exceeds ${max} chars (got ${val.length})`);
  }
}

// 3. Conditional: proposedAction/Rationale required for risk/growth
if (["risk", "growth"].includes(ai_output.signalType)) {
  if (!ai_output.proposedAction || ai_output.proposedAction.trim().length === 0) {
    errors.push("proposedAction is required for risk/growth signals");
  }
  if (!ai_output.proposedRationale || ai_output.proposedRationale.trim().length === 0) {
    errors.push("proposedRationale is required for risk/growth signals");
  }
} else if (["routine"].includes(ai_output.signalType)) {
  if (ai_output.proposedAction || ai_output.proposedRationale) {
    errors.push("proposedAction and proposedRationale must be null for routine signals");
  }
}

if (errors.length > 0) {
  return { valid: false, errors };
}

return { valid: true, payload: ai_output };
```

---

## Supabase Edge Function Payload (final request)

Dieses Payload wird an `POST /functions/v1/customer-signal-ingress` mit Header `x-cs-signal-token` gesendet:

```json
{
  "messageId": "{{ gmail_message_id }}",
  "senderEmail": "{{ gmail_from_email }}",
  "topic": "{{ validated_ai_output.topic }}",
  "signalType": "{{ validated_ai_output.signalType }}",
  "sentiment": "{{ validated_ai_output.sentiment }}",
  "urgency": "{{ validated_ai_output.urgency }}",
  "summary": "{{ validated_ai_output.summary }}",
  "evidence": "{{ validated_ai_output.evidence }}",
  "classifier": "{{ validated_ai_output.classifier }}",
  "proposedAction": "{{ validated_ai_output.proposedAction }}",
  "proposedRationale": "{{ validated_ai_output.proposedRationale }}"
}
```

---

## Edge Function Response Handling

**Success (HTTP 200):**
```json
{
  "signalId": "uuid",
  "matchStatus": "matched" | "unknown" | "ambiguous",
  "accountId": "ACC-XX" | null,
  "duplicate": false
}
```

- `matched`: signal saved, account_id set, health will be recalculated
- `unknown`: signal saved, no account_id (sender not in account_contacts)
- `ambiguous`: signal saved, no account_id (sender maps to multiple accounts)
- `duplicate: true`: message was already processed (same messageId, same source_mailbox)

**Error (HTTP non-2xx):**
- Log the error, do NOT retry
- Workflow should record failure for manual review

---

## Gmail Message ID Format

The `messageId` field must match: `/^[a-f\d]{10,160}$/i`

Gmail Message IDs are typically hex strings, e.g.:
- `18cfa88bcf12345` (15 chars)
- `abc123def456789` (15-20 chars, varies)

**n8n Gmail Trigger provides:** `message.id` — use this directly (already hex format).

---

## Secrets & Tokens

**NEVER in Workflow Export or Code:**
- `x-cs-signal-token` value
- Gmail API credentials
- Supabase URL (base domain okay, API key forbidden)

**Store in Supabase Secrets / n8n Credentials only:**
- `CUSTOMER_SIGNAL_INGRESS_TOKEN` (Supabase)
- `CS_SIGNAL_INGRESS_TOKEN` (n8n, reference from HTTP node, don't paste inline)
