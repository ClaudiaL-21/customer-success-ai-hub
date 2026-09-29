# Workflow C — Build Steps (in n8n)

**Build this workflow manually in n8n. Takes ~15 minutes. No code knowledge needed.**

---

## Setup

1. Open n8n: https://ki-automatisierung.startplatz-ai-hub.de/
2. Click **"+ New"** → **"New Workflow"**
3. Name: `Email Signal Ingestion (Sprint 15C)`
4. Save

---

## Node 1: Gmail Trigger

1. Click **"Add Node"** in the canvas
2. Search: **"Gmail"** → Select **"Gmail Trigger"**
3. **Trigger On:** "New Message"
4. **Authentication:** Select `Gmail - Demo CS AI Hub Inbox`
5. **Mailbox:** Should auto-show `democsaihub@gmail.com`
6. **Label Filter:** (leave empty)
7. **Mark as Read:** Yes
8. **Save**

---

## Node 2: Gmail: Read Email

1. Click **"Add Node"** (after Gmail Trigger)
2. Search: **"Gmail"** → Select **"Gmail: Read Email"**
3. **Authentication:** Same as above
4. **Mailbox:** `democsaihub@gmail.com`
5. **Message ID:** Click **"Add Expression"** → `{{ $json.message.id }}`
6. **Format:** "Plain text"
7. **Save**

---

## Node 3: Format AI Request (Code)

1. Click **"Add Node"**
2. Search: **"Code"** → Select **"Code"**
3. Paste this JavaScript:

```javascript
const messageId = $json.message.id;
const sender = $json.message.from || "unknown";
const subject = $json.message.subject || "(no subject)";
const body = $json.message.body || $json.message.text || "(no body)";

// Extract email from "Name <email>" format
const emailMatch = sender.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
const senderEmail = emailMatch ? emailMatch[1] : sender;

const systemPrompt = `You are a customer signal classifier. Classify this email as risk, growth, or routine.

CRITICAL RULES:
1. Return ONLY valid JSON with these exact fields (all required):
   - topic (1-100 chars)
   - signalType ("risk" | "growth" | "routine")
   - sentiment ("positive" | "neutral" | "negative")
   - urgency ("low" | "medium" | "high")
   - summary (1-500 chars)
   - evidence (1-300 chars, direct quote from email)
   - classifier ("gpt-5-mini-signal-classifier")
   - proposedAction (required if risk/growth, else null)
   - proposedRationale (required if risk/growth, else null)

2. If signalType is "risk" or "growth": both proposedAction and proposedRationale MUST be non-empty strings.
3. If signalType is "routine": both must be null.
4. NO explanations, NO markdown, ONLY JSON.`;

const userPrompt = `From: ${senderEmail}
Subject: ${subject}

Body:
${body}

Classify this. Return JSON only.`;

return {
  system: systemPrompt,
  user: userPrompt,
  maxTokens: 800,
  messageId: messageId,
  senderEmail: senderEmail,
  timestamp: new Date().toISOString()
};
```

4. **Save**

---

## Node 4: OpenAI Chat Model

1. Click **"Add Node"**
2. Search: **"OpenAI"** → Select **"OpenAI: Chat Model"**
3. **Authentication:** Select the credential from Workflow A (should auto-appear)
4. **Model:** `gpt-5-mini`
5. **System Message:** Click "Add Expression" → `{{ $json.system }}`
6. **User Message:** Click "Add Expression" → `{{ $json.user }}`
7. **Max Tokens:** Click "Add Expression" → `{{ $json.maxTokens }}`
8. **Temperature:** 0
9. **Response Format:** "JSON" (if available)
10. **Save**

---

## Node 5: Validate Response (Code)

1. Click **"Add Node"**
2. Search: **"Code"** → Select **"Code"**
3. Paste this JavaScript:

```javascript
let ai_output;
try {
  // Handle both string and object responses
  ai_output = typeof $json.text === "string" ? JSON.parse($json.text) : $json.text;
} catch (e) {
  return { valid: false, errors: ["Invalid JSON from AI"], messageId: $json.messageId };
}

const errors = [];

// Enum validation
if (!["risk", "growth", "routine"].includes(ai_output.signalType)) {
  errors.push("signalType invalid");
}
if (!["positive", "neutral", "negative"].includes(ai_output.sentiment)) {
  errors.push("sentiment invalid");
}
if (!["low", "medium", "high"].includes(ai_output.urgency)) {
  errors.push("urgency invalid");
}

// Length validation
const limits = { topic: 100, summary: 500, evidence: 300, classifier: 100, proposedAction: 700, proposedRationale: 500 };
for (const [field, max] of Object.entries(limits)) {
  const val = (ai_output[field] || "").toString().trim();
  if (val.length > max) errors.push(`${field} too long`);
}

// Conditional validation
if (["risk", "growth"].includes(ai_output.signalType)) {
  if (!ai_output.proposedAction || ai_output.proposedAction.trim().length === 0) {
    errors.push("proposedAction required for risk/growth");
  }
  if (!ai_output.proposedRationale || ai_output.proposedRationale.trim().length === 0) {
    errors.push("proposedRationale required for risk/growth");
  }
}

if (errors.length > 0) {
  return { valid: false, errors, messageId: $json.messageId };
}

return {
  valid: true,
  payload: ai_output,
  messageId: $json.messageId,
  senderEmail: $json.senderEmail,
  timestamp: $json.timestamp
};
```

4. **Save**

---

## Node 6: IF — Check Validation

1. Click **"Add Node"**
2. Search: **"IF"** → Select **"IF"**
3. **Condition:** 
   - Field: `valid` (click "Add Expression" → `{{ $json.valid }}`)
   - Operator: "Equal to"
   - Value: `true`
4. **Save**

This creates two branches: "True" and "False"

---

## Node 7a: HTTP Request (SUCCESS PATH)

**Connect to the "True" branch of the IF node**

1. Click **"Add Node"** (on True branch)
2. Search: **"HTTP Request"** → Select **"HTTP Request"**
3. **Method:** POST
4. **URL:** `https://cbzxrbrfwifxvbvljelh.supabase.co/functions/v1/customer-signal-ingress`
5. **Authentication:** None
6. **Headers:**
   - Add Header 1:
     - Name: `Content-Type`
     - Value: `application/json`
   - Add Header 2:
     - Name: `x-cs-signal-token`
     - Value: (paste your Ingress Token here)
7. **Body:** Select "Raw" and paste:

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

8. **Error Handling:** "Continue on Error" (do NOT stop on error)
9. **Save**

---

## Node 8a: Handle Response (Code, SUCCESS)

**Connect after HTTP Request node**

1. Click **"Add Node"**
2. Search: **"Code"** → Select **"Code"**
3. Paste:

```javascript
const response = $json.body || $json;
return {
  status: "success",
  signalId: response.signalId,
  matchStatus: response.matchStatus,
  accountId: response.accountId || null,
  duplicate: response.duplicate === true,
  timestamp: new Date().toISOString()
};
```

4. **Save**

---

## Node 7b: Handle Validation Error (CODE, FALSE BRANCH)

**Connect to the "False" branch of the IF node**

1. Click **"Add Node"** (on False branch)
2. Search: **"Code"** → Select **"Code"**
3. Paste:

```javascript
return {
  error: true,
  errors: $json.errors || [],
  messageId: $json.messageId,
  senderEmail: $json.senderEmail,
  timestamp: new Date().toISOString()
};
```

4. **Save**

---

## Final Step: Save Workflow

1. Click **"Save"** (top right)
2. Workflow is now ready to test

---

## Test

1. Open this workflow in n8n
2. Send a test email to `democsaihub@gmail.com` from `support@alpenbank.test`
3. Click **"Test Workflow"** or let it trigger automatically
4. Check execution history for:
   - Node 4 (OpenAI) returns valid JSON
   - Node 5 (Validation) returns `valid: true`
   - Node 7a (HTTP Request) returns 200 status
   - Node 8a (Handle Response) shows `signalId`, `matchStatus: "matched"`, `accountId: "ACC-01"`

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Gmail Trigger not showing emails | Confirm credential is authorized for democsaihub@gmail.com |
| OpenAI returns error | Check API key is valid; confirm model name is correct |
| HTTP Request returns 401 | Ingress Token in Header is wrong or doesn't match Supabase Secret |
| HTTP Request returns 503 | Supabase secret not deployed yet; redeploy Edge Function |
| Validation fails | Check AI output JSON format; may need to adjust system prompt |

---

## What's Next?

After first successful test:
- [ ] Seed account_contacts with test emails
- [ ] Test with unknown sender (no match)
- [ ] Test with duplicate email (send twice)
- [ ] Wire NBA approval flow
- [ ] Test end-to-end in Hub
