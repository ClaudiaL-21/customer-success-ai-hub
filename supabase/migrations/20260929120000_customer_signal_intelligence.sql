-- Sprint 15C: a narrow, server-only inbox for synthetic customer signals.
-- The existing account snapshot and its eight scoring inputs are unchanged.
create table public.account_contacts (
  email text not null check (email = lower(btrim(email)) and length(email) <= 254),
  account_id text not null references public.accounts(account_id),
  primary key (email, account_id)
);
create index account_contacts_account_idx on public.account_contacts(account_id);

create table public.customer_signals (
  signal_id uuid primary key default gen_random_uuid(),
  source_mailbox text not null check (source_mailbox = 'democsaihub@gmail.com'),
  source_message_id text not null check (length(source_message_id) between 1 and 160),
  sender_email text not null check (sender_email = lower(btrim(sender_email)) and length(sender_email) <= 254),
  account_id text references public.accounts(account_id),
  match_status text not null check (match_status in ('matched', 'unknown', 'ambiguous')),
  topic text not null check (length(topic) between 1 and 100),
  signal_type text not null check (signal_type in ('risk', 'growth', 'routine')),
  sentiment text not null check (sentiment in ('positive', 'neutral', 'negative')),
  urgency text not null check (urgency in ('low', 'medium', 'high')),
  summary text not null check (length(summary) between 1 and 500),
  evidence text not null check (length(evidence) between 1 and 300),
  classifier text not null check (length(classifier) between 1 and 100),
  health_delta smallint not null default 0 check (health_delta in (-10, -5, 0)),
  health_rule text not null default 'signal-risk-v1',
  proposed_action text check (proposed_action is null or length(proposed_action) between 1 and 700),
  proposed_rationale text check (proposed_rationale is null or length(proposed_rationale) between 1 and 500),
  review_status text check (review_status in ('pending', 'claimed', 'logged', 'sent', 'uncertain')),
  reviewed_by_csm_id text references public.csms(csm_id),
  reviewed_at timestamptz,
  reviewed_action text,
  reviewed_category text check (reviewed_category in ('risk_mitigation', 'growth')),
  reviewed_rationale text,
  delivery_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source_mailbox, source_message_id),
  constraint matched_account check ((match_status = 'matched') = (account_id is not null)),
  constraint unmatched_no_effect check (match_status = 'matched' or (health_delta = 0 and review_status is null)),
  constraint reviewed_fields check (
    (review_status in ('claimed', 'logged', 'sent', 'uncertain')) = (reviewed_at is not null)
  )
);
create index customer_signals_account_created_idx on public.customer_signals(account_id, created_at desc)
  where account_id is not null;

alter table public.account_contacts enable row level security;
alter table public.customer_signals enable row level security;
revoke all on public.account_contacts, public.customer_signals from public, anon, authenticated, service_role;
grant select on public.account_contacts to service_role;
grant select, insert, update on public.customer_signals to service_role;
create policy backend_contacts_read on public.account_contacts for select to service_role using (true);
create policy backend_signals_read on public.customer_signals for select to service_role using (true);
create policy backend_signals_insert on public.customer_signals for insert to service_role with check (true);
create policy backend_signals_update on public.customer_signals for update to service_role using (true) with check (true);

-- Only the backend key can execute this transaction. Exact address matching
-- deliberately allows multiple account contacts for one address so ambiguous
-- matches can be quarantined rather than silently assigned.
create function public.hub_ingest_customer_signal(payload jsonb)
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
    health_delta, proposed_action, proposed_rationale, review_status
  ) values (
    'democsaihub@gmail.com', payload ->> 'messageId', sender,
    case when matches = 1 then matched_account else null end,
    case when matches = 0 then 'unknown' when matches = 1 then 'matched' else 'ambiguous' end,
    payload ->> 'topic', kind, payload ->> 'sentiment', urgency_value,
    payload ->> 'summary', payload ->> 'evidence', payload ->> 'classifier',
    case when matches = 1 and kind = 'risk' then
      case when urgency_value = 'high' then -10 else -5 end else 0 end,
    case when matches = 1 and kind in ('risk','growth') then payload ->> 'proposedAction' else null end,
    case when matches = 1 and kind in ('risk','growth') then payload ->> 'proposedRationale' else null end,
    case when matches = 1 and kind in ('risk','growth') then 'pending' else null end
  ) on conflict (source_mailbox, source_message_id) do nothing
  returning * into row;
  if found then inserted := true; end if;
  if not inserted then
    select * into row from public.customer_signals
    where source_mailbox = 'democsaihub@gmail.com' and source_message_id = payload ->> 'messageId';
  end if;
  return jsonb_build_object('signalId', row.signal_id, 'matchStatus', row.match_status,
    'accountId', row.account_id, 'duplicate', not inserted);
end;
$$;
revoke all on function public.hub_ingest_customer_signal(jsonb) from public, anon, authenticated;
grant execute on function public.hub_ingest_customer_signal(jsonb) to service_role;

-- Preserve the single-statement account snapshot. Only safe, synthetic signal
-- summaries reach the local Hub; sender addresses and provider IDs stay private.
create or replace function public.hub_account_dataset()
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select m.data || jsonb_build_object(
    'csms', coalesce((select jsonb_agg(c.data order by c.source_order) from public.csms c), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(a.data || jsonb_build_object(
      'customerSignals', coalesce((select jsonb_agg(jsonb_build_object(
        'signalId', s.signal_id, 'type', s.signal_type, 'topic', s.topic,
        'sentiment', s.sentiment, 'urgency', s.urgency, 'summary', s.summary,
        'evidence', s.evidence, 'healthDelta', s.health_delta, 'healthRule', s.health_rule,
        'proposedAction', s.proposed_action, 'proposedRationale', s.proposed_rationale,
        'reviewStatus', s.review_status, 'reviewedAt', s.reviewed_at,
        'reviewedByCsmId', s.reviewed_by_csm_id, 'reviewedAction', s.reviewed_action,
        'deliveryAt', s.delivery_at, 'createdAt', s.created_at
      ) order by s.created_at desc) from public.customer_signals s where s.account_id = a.account_id), '[]'::jsonb)
    ) order by a.source_order) from public.accounts a), '[]'::jsonb)
  ) from public.dataset_metadata m where m.id = 'hub';
$$;
revoke all on function public.hub_account_dataset() from public, anon, authenticated;
grant execute on function public.hub_account_dataset() to service_role;
