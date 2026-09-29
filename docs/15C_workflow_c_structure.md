# Workflow C: Email Signal Ingestion — Node-by-Node Structure

**Status:** Ready for n8n implementation (no code yet, structure only)

**Prerequisites:**
- n8n 1.x with Gmail, OpenAI, and HTTP Request nodes
- Gmail OAuth configured for `democsaihub@gmail.com`
- Supabase project with deployed Edge Function `customer-signal-ingress`
- Ingress token stored in n8n Credential (not in workflow export)

---

## Node Flow Diagram

```
[1] Gmail Trigger (new message to democsaihub@gmail.com)
         ↓
[2] Gmail: Read Email (fetch full message body)
         ↓
[3] Format AI Request (build system + user prompt from email)
         ↓
[4] OpenAI Chat Model (classify: risk/growth/routine + extract fields)
         ↓
[5] Information Extractor (structured JSON output)
         ↓
[6] Validation Code Node (strict enum/length checks)
         ↓
         ├─→ [7a] SUCCESS PATH: HTTP Request to Edge Function
         │          ↓
         │    [8a] Handle Response (success/duplicate/unknown/ambiguous)
         │          ↓
         │    [9] Log Success (console/n8n execution history)
         │
         └─→ [7b] ERROR PATH: Log Validation Failure
                    ↓
                [9] Mark for Manual Review (optional: send alert)
```

---

## Node Details

### [1] Gmail Trigger

**Configuration:**
- **Authentication:** Gmail OAuth (user will set up)
- **Trigger Event:** "New Message"
- **Mailbox:** `democsaihub@gmail.com`
- **Label Filter:** (none, process all new messages)
- **Mark as Read:** Yes (optional, cleaner inbox)

**Output fields used downstream:**
- `message.id` → messageId (hex string, 10-160 chars)
- `message.from` → sender email (with or without display name, e.g., "John Doe <john@example.com>")
- `message.date` → received timestamp (ISO or Unix)
- `message.subject` → email subject
- `message.textPlain` or `message.content` → full message body

---

### [2] Gmail: Read Email

**Why separate node?** Gmail Trigger provides metadata only. The full email body (plain text) must be fetched separately.

**Configuration:**
- **Mailbox:** `democsaihub@gmail.com`
- **Message ID:** `{{ $json.message.id }}`
- **Download Attachments:** No (skip, only body needed)
- **Format:** Plain text (prefer plain text over HTML)

**Output:**
- `message.body` or `message.text` → full message body text
- `message.headers.from` → sender (clean version)
- `message.headers.date` → received timestamp

---

### [3] Format AI Request

**Node Type:** Code Node (JavaScript)

**Purpose:** Build the system + user prompt for the AI classifier.

**Input:** Gmail message data from [1] + [2]

**JavaScript Logic:**

```javascript
// Extract email data
const messageId = $json.message.id;
const sender = $json.message.from; // e.g., "john@example.com" or "John Doe <john@example.com>"
const subject = $json.message.subject;
const body = $json.message.body || $json.message.text;

// Extract email address from sender (handle "Name <email>" format)
const emailMatch = sender.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
const senderEmail = emailMatch ? emailMatch[1] : sender;

const systemPrompt = `You are a customer signal classifier for a B2B SaaS account success team.
Classify the following customer email as one of three signal types: risk, growth, or routine.

IMPORTANT:
- Risk: Something is going wrong, customer is frustrated, churning risk, or critical issue
- Growth: Expansion opportunity, positive indicator, upsell trigger
- Routine: Normal operational question, no urgency, status update

Return a JSON object with these exact fields (all required):
- topic: 1-100 chars, key subject (e.g., "Integration failure", "Expansion inquiry")
- signalType: "risk" | "growth" | "routine"
- sentiment: "positive" | "neutral" | "negative"
- urgency: "low" | "medium" | "high"
- summary: 1-500 chars, concise summary of the email
- evidence: 1-300 chars, direct quote or key phrase from the email
- classifier: name of this classifier version (e.g., "gpt-5-mini-20260929")
- proposedAction: if risk/growth, a 1-700 char action recommendation; otherwise null
- proposedRationale: if risk/growth, 1-500 char reason; otherwise null

DO NOT include any fields beyond these. Return valid JSON only.`;

const userPrompt = `Email Metadata:
From: ${senderEmail}
Date: ${$json.message.date || 'unknown'}
Subject: ${subject}

Email Body:
${body}

Classify this email. Return JSON.`;

return {
  system: systemPrompt,
  user: userPrompt,
  maxTokens: 1200,
  messageId: messageId,
  senderEmail: senderEmail,
  subject: subject,
  timestamp: $json.message.date
};
```

**Output:** `{ system, user, maxTokens, messageId, senderEmail, subject, timestamp }`

---

### [4] OpenAI Chat Model

**Configuration:**
- **Model:** `gpt-5-mini` (or latest available)
- **System Message:** `{{ $json.system }}`
- **Message:** `{{ $json.user }}`
- **Max Tokens:** `{{ $json.maxTokens }}`
- **Temperature:** 0 (deterministic, no randomness for structured output)
- **Response Format:** JSON (enable JSON mode if available in model)
- **Top P:** 1 (or default)

**Output:** `text` field containing the raw JSON response

---

### [5] Information Extractor

**Alternative to [4]:**

If OpenAI Chat Model isn't configured properly in your n8n version, use **Information Extractor + Chat Model separately:**

**Information Extractor Node:**
- **LLM:** OpenAI (configured)
- **Model:** gpt-5-mini
- **System Context:** (leave empty, we'll pass system in Chat Model)
- **Prompt:** `{{ $json.user }}`
- **Schema:** (paste this JSON schema)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "topic": { "type": "string", "maxLength": 100 },
    "signalType": { "type": "string", "enum": ["risk", "growth", "routine"] },
    "sentiment": { "type": "string", "enum": ["positive", "neutral", "negative"] },
    "urgency": { "type": "string", "enum": ["low", "medium", "high"] },
    "summary": { "type": "string", "maxLength": 500 },
    "evidence": { "type": "string", "maxLength": 300 },
    "classifier": { "type": "string", "maxLength": 100 },
    "proposedAction": { "type": ["string", "null"], "maxLength": 700 },
    "proposedRationale": { "type": ["string", "null"], "maxLength": 500 }
  },
  "required": ["topic", "signalType", "sentiment", "urgency", "summary", "evidence", "classifier", "proposedAction", "proposedRationale"]
}
```

**Output:** `json` field with structured extraction

---

### [6] Validation Code Node

**Purpose:** Validate AI output against strict rules. Halt workflow if validation fails.

**Input:** AI output from [4] or [5]

**JavaScript Logic:** (see `docs/15C_email_ingestion_payload_schema.md` for full code)

**Output:**
```javascript
return {
  valid: true,
  payload: { topic, signalType, sentiment, urgency, summary, evidence, classifier, proposedAction, proposedRationale },
  messageId: $json.messageId,
  senderEmail: $json.senderEmail,
  timestamp: $json.timestamp
};
// On error:
// return { valid: false, errors: [...], messageId: ... };
```

---

### [7a] SUCCESS PATH: HTTP Request (to Supabase Edge Function)

**Condition:** `{{ $json.valid === true }}`

**Configuration:**
- **URL:** `https://cbzxrbrfwifxvbvljelh.supabase.co/functions/v1/customer-signal-ingress`
- **Method:** POST
- **Headers:**
  - `Content-Type: application/json`
  - `x-cs-signal-token: {{ $env.CUSTOMER_SIGNAL_INGRESS_TOKEN }}` (from n8n Credentials/Secrets)
- **Body:** (raw JSON)

```json
{
  "messageId": "{{ $json.messageId }}",
  "senderEmail": "{{ $json.senderEmail }}",
  "topic": "{{ $json.payload.topic }}",
  "signalType": "{{ $json.payload.signalType }}",
  "sentiment": "{{ $json.payload.sentiment }}",
  "urgency": "{{ $json.payload.urgency }}",
  "summary": "{{ $json.payload.summary }}",
  "evidence": "{{ $json.payload.evidence }}",
  "classifier": "{{ $json.payload.classifier }}",
  "proposedAction": "{{ $json.payload.proposedAction }}",
  "proposedRationale": "{{ $json.payload.proposedRationale }}"
}
```

**Error Handling:**
- Don't retry on failure (HTTP error = real problem, not transient)
- Treat HTTP non-2xx as workflow error → go to [7b]

---

### [8a] Handle Response (Success Path)

**Condition:** HTTP Request returned 200 + valid JSON

**Code Node:**

```javascript
const response = $json.body;
if (!response.signalId) {
  return { error: "Invalid response: missing signalId", response };
}

const status = {
  signalId: response.signalId,
  matchStatus: response.matchStatus, // "matched" | "unknown" | "ambiguous"
  accountId: response.accountId || null,
  duplicate: response.duplicate === true,
  timestamp: new Date().toISOString()
};

if (response.duplicate) {
  return { status: "duplicate", ...status };
} else if (response.matchStatus === "matched") {
  return { status: "success", ...status };
} else if (response.matchStatus === "unknown") {
  return { status: "unknown_sender", ...status };
} else if (response.matchStatus === "ambiguous") {
  return { status: "ambiguous_sender", ...status };
}

return { status: "unknown", ...status };
```

---

### [7b] ERROR PATH: Log Validation Failure

**Condition:** `{{ $json.valid === false }}` (from [6]) OR HTTP Request failed

**Node Type:** Code Node

**Output:**
```javascript
return {
  error: true,
  messageId: $json.messageId || "unknown",
  senderEmail: $json.senderEmail || "unknown",
  reason: $json.errors?.join("; ") || "HTTP request failed",
  timestamp: new Date().toISOString()
};
```

---

### [9] Logging

**Node Type:** Execute Workflow

Or use built-in n8n **History** for every execution. This workflow should NOT need an additional logging node; n8n's execution history tracks all input/output.

**Optional:** If you want Slack/Email alerts for failures, add a conditional Slack/Email node after [7b].

---

## Test Case: Risk Signal

**Test Email to democsaihub@gmail.com:**

```
From: support@alpenbank.test
Subject: Integration Failure Alert
Date: 2026-09-29

Body:
Hi,

We've been unable to complete customer orders through your API integration for the past 3 hours. 
Our development team reports: "Connection timeout on POST /orders — error 503 Service Unavailable".

This is critical for our Q4 operations. Can you help us resolve this immediately?

Thanks,
Alpenbank Support
```

**Expected Output (Edge Function Response):**

```json
{
  "signalId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "matchStatus": "matched",
  "accountId": "ACC-01",
  "duplicate": false
}
```

**Expected Hub Behavior:**

1. Signal appears in ACC-01 Account Detail → "Customer Signals" section
2. Health Score: base score + signal delta (-5 for medium urgency risk, -10 for high)
3. Proposed Action shown: "Review the integration logs and coordinate with Alpenbank's dev team"
4. Review Status: "pending" (awaiting CSM approval in Hub)

---

## Test Case: Unknown Sender

**Test Email from unknown email address:**

```
From: unknown@random-company.test
Subject: API Question
```

**Expected Output:**

```json
{
  "signalId": "xyz...",
  "matchStatus": "unknown",
  "accountId": null,
  "duplicate": false
}
```

**Expected Hub Behavior:**

- Signal stored in database
- NO account shown (accountId is null)
- NO health score change
- CSM can manually review and assign account later (future feature)

---

## Implementation Checklist

- [ ] Seed `account_contacts` with test email + ACC-01
- [ ] Create Workflow C in n8n (draft, not active)
- [ ] Wire nodes [1]–[9] per structure above
- [ ] Set up Gmail OAuth (user must do)
- [ ] Add n8n Credential for Ingress Token (user must do)
- [ ] Test with Risk Signal email
- [ ] Verify signal appears in Hub
- [ ] Verify health score recalculated
- [ ] Clean up and export Workflow C JSON (remove secrets)
- [ ] Commit to git
