# Sprint 15C: Setup Handoff — Gmail OAuth + Ingress Token

**After I've built Workflow C, you must set up these two components.**

---

## 1. Gmail OAuth für democsaihub@gmail.com

### Why?
The Workflow C Gmail Trigger needs permission to read emails from `democsaihub@gmail.com`. This is a one-time OAuth flow in n8n.

### Steps (in n8n UI):

1. Open your n8n workspace: https://ki-automatisierung.startplatz-ai-hub.de/
2. Navigate to **Credentials** (left sidebar)
3. Click **"Create New"** → select **"Google Gmail"**
4. Name: `Gmail - Demo CS AI Hub Inbox` (or similar)
5. Click **"Connect to Google"**
6. Sign in as the user who owns `democsaihub@gmail.com`
7. Grant permissions: "Read emails" is sufficient (uncheck "Modify/Delete" if offered)
8. Confirm and save the credential
9. Test: Navigate to a Gmail trigger node → select this credential → should show `democsaihub@gmail.com` inbox

### What I'll do:
- In Workflow C, I'll reference this credential by name — you don't need to paste anything into the workflow export.

### What NOT to do:
- Don't copy OAuth tokens, refresh tokens, or client IDs into the workflow JSON
- n8n handles this automatically via the Credential reference

---

## 2. Ingress Token Generation & Storage

### What is it?
A 32+ character random secret that authorizes calls from n8n to the Supabase Edge Function. It's **separate from** your Supabase API key.

### Step 1: Generate Token (locally or in password manager)

Option A: Use a password generator
- Length: 32 characters minimum
- Charset: A-Z, a-z, 0-9, and optionally - _ (no special chars that break URLs/headers)
- Example format: `VxdBkP3r7qh_WmBzTBUCeY6OFsgJwVEiJ_aqVjAvH0k`

Option B: Command line (if you have openssl):
```bash
openssl rand -base64 32 | tr -d '\n'
```

Result: a string like `yJ7kL9mN2pQrStUvWxYzAbCdEfGhIjK1lMnOpQrS2tU=`

**Save this string somewhere secure** (password manager, Supabase Secrets, NOT Git or chat).

### Step 2: Add to Supabase Secrets

1. Open your Supabase project: https://supabase.com/dashboard/project/cbzxrbrfwifxvbvljelh
2. Navigate to **Project Settings** → **Secrets**
3. Click **"New Secret"**
4. Name: `CUSTOMER_SIGNAL_INGRESS_TOKEN`
5. Value: `<paste your generated token>`
6. Save
7. Redeploy the Edge Function (it will pick up the new secret automatically)

### Step 3: Add to n8n Credentials

1. In n8n, go to **Credentials** → **"Create New"** → **"Generic API Request"** or **"HTTP Request"**
2. Name: `Supabase Signal Ingress Token`
3. **Authentication:** No Auth required (we'll use headers instead)
4. Add a **Custom Header:**
   - Header Name: `x-cs-signal-token`
   - Header Value: `<paste your generated token>`
5. Save

OR: Create a simple **Environment Variable** credential:
- Name: `CS_SIGNAL_INGRESS_TOKEN`
- Value: `<paste your generated token>`
- Save

### Step 4: Reference in Workflow C

In the HTTP Request node (node [7a]), the header will be:
```
x-cs-signal-token: {{ $env.CS_SIGNAL_INGRESS_TOKEN }}
```

or (if using Credential):

```
x-cs-signal-token: {{ $json.secret }}
```

**I'll include the correct reference in the exported Workflow C JSON.**

---

## 3. When to Tell Me "Ready"

Once you've done steps 1 & 2, message:

```
Gmail OAuth set up: ✓
Ingress Token created: ✓
Supabase secret deployed: ✓
n8n credential saved: ✓
```

Then I will:
1. Build Workflow C JSON with references to your credentials
2. Walk you through importing the JSON into n8n
3. Run the first test (Risk Signal email)
4. Verify end-to-end (email → signal → Hub display)

---

## 4. Verification Checklist

**Before you send "ready":**

### Gmail Credential:
- [ ] n8n shows "Connected to: democsaihub@gmail.com"
- [ ] No error messages
- [ ] Credential name is clear and documented

### Ingress Token:
- [ ] Token is 32+ chars, random
- [ ] Saved in Supabase Secrets under `CUSTOMER_SIGNAL_INGRESS_TOKEN`
- [ ] Saved in n8n Credentials (either way: env var or header)
- [ ] Token is NOT in any code file, Git commit, or this doc

### Edge Function:
- [ ] Redeploy triggered (Supabase auto-detects new secret)
- [ ] Check Supabase Function Logs: no errors
- [ ] Manually test (use `curl` or Postman) with the token to confirm it works

**Optional Manual Test (curl):**

```bash
curl -X POST https://cbzxrbrfwifxvbvljelh.supabase.co/functions/v1/customer-signal-ingress \
  -H "Content-Type: application/json" \
  -H "x-cs-signal-token: YOUR_TOKEN_HERE" \
  -d '{
    "messageId": "abc123def456",
    "senderEmail": "support@alpenbank.test",
    "topic": "Test Signal",
    "signalType": "risk",
    "sentiment": "negative",
    "urgency": "high",
    "summary": "Test summary",
    "evidence": "Test evidence",
    "classifier": "test",
    "proposedAction": "Test action",
    "proposedRationale": "Test rationale"
  }'
```

Expected response:
```json
{
  "signalId": "some-uuid",
  "matchStatus": "matched",
  "accountId": "ACC-01",
  "duplicate": false
}
```

---

## 5. If Something Goes Wrong

**Gmail credential won't connect:**
- Confirm `democsaihub@gmail.com` is the Gmail account's actual email
- Check if 2FA is enabled (may need app-specific password)
- Clear n8n cookies and try again

**Ingress token returns 401 Unauthorized:**
- Confirm token is exactly the same in Supabase Secrets and n8n
- Check for extra spaces or truncation
- Redeploy the Edge Function to pick up new secret

**Ingress token returns 503 Ingress Unavailable:**
- Supabase secret not yet deployed
- Redeploy the Edge Function

---

## Ready?

When all items are checked, reply:

```
✓ Gmail OAuth connected
✓ Ingress Token created + deployed
✓ n8n Credential saved
Ready for Workflow C build
```

Then I'll proceed with the n8n JSON build & first test.
