-- Customer Intelligence Inbox & Case Lifecycle — Package 1: additive schema.
-- See docs/16_customer_intelligence_inbox_concept.md for full rationale.
--
-- account_confirmed is "safe by default": the COLUMN default is false (no
-- fail-open for any future insert that forgets to set it explicitly). Existing
-- rows are then explicitly backfilled to true in one UPDATE below — this does
-- NOT change any existing row's effective health value (they already affect
-- health today under the pre-Inbox logic; this only makes the new flag
-- correctly reflect that pre-existing trusted state, it is not a health change).
--
-- Bridging the ACTIVE Sprint 15C ingestion safely: hub_ingest_customer_signal()
-- is updated below to explicitly set account_confirmed = true whenever it
-- still auto-matches a sender (match_status = 'matched'), exactly preserving
-- today's live behavior. This is the ONLY behavior-adjacent change in this
-- migration, and it changes nothing observable: matching logic, health_delta
-- calculation, and computeHealthScore() (unaware of this column until a later
-- package) are all untouched, so the live n8n workflow keeps working exactly
-- as before, end to end, right through this migration.

create table public.cases (
  case_id uuid primary key default gen_random_uuid(),
  account_id text references public.accounts(account_id),
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
create index cases_account_idx on public.cases(account_id) where account_id is not null;
create index cases_status_idx on public.cases(status);

create table public.verified_account_domains (
  domain text primary key check (domain = lower(btrim(domain)) and length(domain) <= 253),
  account_id text not null references public.accounts(account_id),
  added_by_csm_id text references public.csms(csm_id),
  added_at timestamptz not null default now()
);

create table public.approved_doc_sources (
  url text primary key check (length(url) between 1 and 500),
  title text not null check (length(title) between 1 and 200),
  added_by_csm_id text references public.csms(csm_id),
  added_at timestamptz not null default now()
);

alter table public.customer_signals
  add column thread_id text check (thread_id is null or length(thread_id) between 1 and 160),
  add column inbound_category text check (inbound_category in
    ('information_enablement','collaboration_requests','feedback_issues','account_development_change')),
  add column suggestion_source text check (suggestion_source in
    ('contact_match','verified_domain','name_alias_match','thread_inherited')),
  add column suggested_account_id text references public.accounts(account_id),
  add column suggestion_evidence text check (suggestion_evidence is null or length(suggestion_evidence) between 1 and 500),
  add column account_confirmed boolean not null default false,
  add column confirmed_account_id text references public.accounts(account_id),
  add column confirmed_by_csm_id text references public.csms(csm_id),
  add column confirmed_at timestamptz,
  add column case_id uuid references public.cases(case_id),
  add column processing_status text not null default 'needs_review' check (processing_status in
    ('needs_review','triaged','actioned','archived')),
  add column action_type text check (action_type in
    ('documentation','reply_draft','follow_up_question','meeting_prep','escalation')),
  add column action_sources jsonb not null default '[]'::jsonb,
  add column no_matching_source_found boolean not null default false;

-- One-time backfill: every row that existed BEFORE this migration keeps its
-- current, already-live health effect unchanged. This does not touch
-- health_delta, account_id, or any other existing column — only initializes
-- the new flag to match what was always implicitly true for these rows.
update public.customer_signals set account_confirmed = true;

-- Bridge fix for the active ingestion: preserve today's live behavior for any
-- NEW signal ingested between this migration and the later package that
-- introduces the stricter multi-stage suggestion ladder + Gate 1 UI. Only the
-- account_confirmed assignment is added; the matching logic itself (exact
-- account_contacts lookup) and every other computed value are byte-for-byte
-- unchanged from the currently-deployed function.
create or replace function public.hub_ingest_customer_signal(payload jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  sender text := lower(btrim(payload ->> 'senderEmail'));
  matches integer;
  matched_account text;
  row public.customer_signals%rowtype;
  inserted boolean := false;
  kind text := payload ->> 'signalType';
  urgency_value text := payload ->> 'urgency';
begin
  select count(*), min(account_id) into matches, matched_account
  from public.account_contacts where email = sender;
  insert into public.customer_signals (
    source_mailbox, source_message_id, sender_email, account_id, match_status,
    topic, signal_type, sentiment, urgency, summary, evidence, classifier,
    health_delta, proposed_action, proposed_rationale, review_status,
    account_confirmed
  ) values (
    'claudialiersch@googlemail.com', payload ->> 'messageId', sender,
    case when matches = 1 then matched_account else null end,
    case when matches = 0 then 'unknown' when matches = 1 then 'matched' else 'ambiguous' end,
    payload ->> 'topic', kind, payload ->> 'sentiment', urgency_value,
    payload ->> 'summary', payload ->> 'evidence', payload ->> 'classifier',
    case when matches = 1 and kind = 'risk' then
      case when urgency_value = 'high' then -10 else -5 end else 0 end,
    case when matches = 1 and kind in ('risk','growth') then payload ->> 'proposedAction' else null end,
    case when matches = 1 and kind in ('risk','growth') then payload ->> 'proposedRationale' else null end,
    case when matches = 1 and kind in ('risk','growth') then 'pending' else null end,
    matches = 1  -- preserves current live behavior: exact match stays trusted until Package 5 tightens this
  ) on conflict (source_mailbox, source_message_id) do nothing
  returning * into row;
  if found then inserted := true; end if;
  if not inserted then
    select * into row from public.customer_signals
    where source_mailbox = 'claudialiersch@googlemail.com' and source_message_id = payload ->> 'messageId';
  end if;
  return jsonb_build_object('signalId', row.signal_id, 'matchStatus', row.match_status,
    'accountId', row.account_id, 'duplicate', not inserted);
end;
$$;
revoke all on function public.hub_ingest_customer_signal(jsonb) from public, anon, authenticated;
grant execute on function public.hub_ingest_customer_signal(jsonb) to service_role;

-- RLS: same lockdown posture as every existing table in this schema —
-- service_role only, nothing for public/anon/authenticated.
alter table public.cases enable row level security;
alter table public.verified_account_domains enable row level security;
alter table public.approved_doc_sources enable row level security;

revoke all on public.cases, public.verified_account_domains, public.approved_doc_sources
  from public, anon, authenticated, service_role;

grant select, insert, update on public.cases to service_role;
grant select, insert, update, delete on public.verified_account_domains to service_role;
grant select, insert, update, delete on public.approved_doc_sources to service_role;

create policy backend_cases_all on public.cases for all to service_role using (true) with check (true);
create policy backend_domains_all on public.verified_account_domains for all to service_role using (true) with check (true);
create policy backend_sources_all on public.approved_doc_sources for all to service_role using (true) with check (true);
