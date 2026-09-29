-- Sprint 15C: Demo contact mappings for Email Signal Ingestion workflow
-- These test addresses map to synthetuc accounts for risk-signal testing.
-- Each row allows an email sender to be matched to an account for signal classification.

-- Test Case 1: Risk Signal (Alpenbank AG complaint)
insert into public.account_contacts (email, account_id) values ('support@alpenbank.test', 'ACC-01');

-- Test Case 2: Growth Signal (Customer expansion inquiry)
insert into public.account_contacts (email, account_id) values ('procurement@benelux-mobility.test', 'ACC-10');

-- Test Case 3: Unknown Sender (no mapping) — should produce "unknown" match_status
-- (deliberately omitted — ingress will assign match_status='unknown')

-- Test Case 4: Ambiguous Sender (multiple accounts) — to test conflict handling
insert into public.account_contacts (email, account_id) values ('shared-mailbox@multi-tenant.test', 'ACC-05');
insert into public.account_contacts (email, account_id) values ('shared-mailbox@multi-tenant.test', 'ACC-06');
