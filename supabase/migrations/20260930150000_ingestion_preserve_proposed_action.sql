-- Sprint 15C Final Integration Fix — Gate 1 -> Health/NBA -> Gate 2.
--
-- Package 5 (20260930140000) made account_confirmed always false at
-- ingestion, but its insert also discarded proposed_action/proposed_rationale
-- for any signal without an automatic account match (matches != 1), even
-- though the AI classifier already produced them for every risk/growth
-- signal (see docs/15C_email_ingestion_payload_schema.md — required,
-- non-null fields for signalType in ('risk','growth'), validated by the
-- customer-signal-ingress edge function before this RPC is ever called).
--
-- That meant an unknown/ambiguous-sender signal could never reach Gate 2 at
-- all, even after a human confirmed its account in Gate 1: the classified
-- action the AI already produced was thrown away the moment the row was
-- inserted, with nothing left to activate later.
--
-- Fix, scoped to exactly this: proposed_action/proposed_rationale are now
-- always stored for a risk/growth signal, regardless of match_status. They
-- remain inert while account_confirmed=false — nothing reads them until Gate
-- 1 confirms the account (src/inbox.js only renders Gate 2 once
-- effectivelyConfirmed is true), and this migration does not touch that
-- gating. health_delta and review_status are UNCHANGED here (still only set
-- for an automatic match at ingestion): activating those for a signal
-- confirmed after the fact is done at confirmation time instead, in
-- api/confirm-signal-account.js, using this same stored proposed_action as
-- the signal that activation is due.

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
    account_confirmed, suggested_account_id, suggestion_source
  ) values (
    'claudialiersch@googlemail.com', payload ->> 'messageId', sender,
    case when matches = 1 then matched_account else null end,
    case when matches = 0 then 'unknown' when matches = 1 then 'matched' else 'ambiguous' end,
    payload ->> 'topic', kind, payload ->> 'sentiment', urgency_value,
    payload ->> 'summary', payload ->> 'evidence', payload ->> 'classifier',
    case when matches = 1 and kind = 'risk' then
      case when urgency_value = 'high' then -10 else -5 end else 0 end,
    case when kind in ('risk','growth') then payload ->> 'proposedAction' else null end,
    case when kind in ('risk','growth') then payload ->> 'proposedRationale' else null end,
    case when matches = 1 and kind in ('risk','growth') then 'pending' else null end,
    false,
    case when matches = 1 then matched_account else null end,
    case when matches = 1 then 'contact_match' else null end
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
