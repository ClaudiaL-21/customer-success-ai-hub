# Workflow C Import Guide

**Status:** Ready to build and import into n8n

## Pre-Import Checklist

- [ ] Gmail OAuth 2 API credential exists in n8n (`Gmail - Demo CS AI Hub Inbox`)
- [ ] Ingress Token generated and saved in Supabase Secrets (`CUSTOMER_SIGNAL_INGRESS_TOKEN`)
- [ ] You have the Ingress Token value ready (same one in Supabase)

---

## Step 1: Get Workflow C JSON

I will provide the complete workflow JSON below.

## Step 2: Import into n8n

1. Open n8n: https://ki-automatisierung.startplatz-ai-hub.de/
2. Click **"+"** → **"Import from file"** (or paste JSON)
3. Paste the JSON from Step 1
4. Click **"Import"**
5. n8n will ask for credentials:
   - **Gmail Credential:** Select `Gmail - Demo CS AI Hub Inbox`
   - **OpenAI Credential:** Reuse the one from Workflow A (it will show up)
   - Confirm

## Step 3: Configure HTTP Request Node

**Node: "HTTP Request to Edge Function"**

Find the Custom Header section and set:
- **Header Name:** `x-cs-signal-token`
- **Header Value:** (paste your Ingress Token here)

## Step 4: Seed account_contacts

Before testing, seed the demo contacts in Supabase:

```sql
-- Run this in Supabase SQL Editor
insert into public.account_contacts (email, account_id) values ('support@alpenbank.test', 'ACC-01');
insert into public.account_contacts (email, account_id) values ('procurement@benelux-mobility.test', 'ACC-10');
```

## Step 5: Test with Demo Email

Send a test email to `democsaihub@gmail.com` from a test sender (e.g., `support@alpenbank.test`):

**Subject:** Integration Failure Alert

**Body:**
```
Hi,

We've been unable to complete customer orders through your API integration for the past 3 hours. 
Our development team reports: "Connection timeout on POST /orders — error 503 Service Unavailable".

This is critical for our Q4 operations. Can you help us resolve this immediately?

Thanks,
Alpenbank Support
```

## Step 6: Verify End-to-End

1. **Check n8n Execution History:**
   - Open Workflow C
   - Should show successful execution
   - Response from Edge Function should be `{ "signalId": "...", "matchStatus": "matched", "accountId": "ACC-01", "duplicate": false }`

2. **Check Hub:**
   - Open localhost:5173 (or your Hub URL)
   - Navigate to **ACC-01** Account Detail
   - Scroll to **"Customer Signals"** section
   - Signal should appear with:
     - type: "risk"
     - topic: "Integration Failure"
     - urgency: "high"
     - sentiment: "negative"
     - summary + evidence from email
   - Health Score should show:
     - Eight-factor base score (unchanged)
     - Signal delta: -10 (high urgency risk)
     - New total: base - 10

3. **Check for NBA (Next Best Action):**
   - Proposed Action should appear below the signal
   - Review Status: "pending" (awaiting CSM approval)

4. **Test Approval Flow:**
   - Click "Review Action" in the signal card
   - Edit the action if desired
   - Click "Approve"
   - Should send to n8n Approval Workflow (existing)
   - Gmail draft should be created
   - Sheet row should be logged

---

## Troubleshooting

### Edge Function returns 401 Unauthorized
- Check: Is the Ingress Token in the HTTP Request node exactly the same as in Supabase?
- Check: Did you redeploy the Edge Function after adding the secret?

### Edge Function returns 503 Ingress Unavailable
- Supabase secret not deployed yet
- Redeploy Edge Function

### Gmail Trigger doesn't fetch emails
- Confirm Gmail OAuth credential is authorized for `democsaihub@gmail.com`
- Check n8n credentials page

### OpenAI returns error
- Check: Is the existing OpenAI credential still valid?
- Check: Token limits are 800 max per call
- Check: Model is `gpt-5-mini` or available model

### Signal doesn't appear in Hub after 30 seconds
- Refresh the page (browser)
- Check Hub console for errors (F12 → Console)
- Check n8n execution history for error details

---

## Next Steps After First Test

- [ ] Test with "unknown sender" (no email in account_contacts) → should create signal with `matchStatus="unknown"`
- [ ] Test with "ambiguous sender" (multiple accounts mapped) → should create signal with `matchStatus="ambiguous"`
- [ ] Test duplicate handling (send same email twice) → should return `duplicate=true`
- [ ] Test NBA approval flow → existing approval workflow should execute
- [ ] Verify Sheet row is logged
- [ ] Verify Gmail draft is created

---

## Workflow C Structure Summary

```
Gmail Trigger (new message to democsaihub@gmail.com)
    ↓
Gmail: Read Email (fetch full body)
    ↓
Code: Format AI Request (build system + user prompt)
    ↓
OpenAI Chat Model (classify + extract fields)
    ↓
Code: Validate Response (strict enum/length checks)
    ↓
    ├─→ If valid:
    │    ├─→ HTTP Request: Call Supabase Edge Function
    │    └─→ Code: Handle Success/Duplicate/Unknown
    │
    └─→ If invalid:
         └─→ Code: Log Validation Error
```

---

## Security Notes

- **Never commit the Ingress Token value in the workflow JSON** — it's entered in the HTTP node after import
- **Don't export the workflow with secrets** — n8n handles this automatically (secrets become credential references)
- **Gmail OAuth is secure** — n8n manages the token refresh
- **OpenAI API key is never visible** — stored in n8n credentials
