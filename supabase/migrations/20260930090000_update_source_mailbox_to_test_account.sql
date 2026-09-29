-- Sprint 15C: Switch demo mailbox from unreachable democsaihub@gmail.com
-- (blocked by Google's unverified-app OAuth restriction for new accounts —
-- only the OAuth app's own test users can authorize a new n8n Gmail credential)
-- to the already-authorized claudia.liersch@googlemail.com test account.
-- Cosmetic change only — no functional impact on ingress/matching logic.

alter table public.customer_signals drop constraint customer_signals_source_mailbox_check;
alter table public.customer_signals add constraint customer_signals_source_mailbox_check
  check (source_mailbox = 'claudia.liersch@googlemail.com');

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
    health_delta, proposed_action, proposed_rationale, review_status
  ) values (
    'claudia.liersch@googlemail.com', payload ->> 'messageId', sender,
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
    where source_mailbox = 'claudia.liersch@googlemail.com' and source_message_id = payload ->> 'messageId';
  end if;
  return jsonb_build_object('signalId', row.signal_id, 'matchStatus', row.match_status,
    'accountId', row.account_id, 'duplicate', not inserted);
end;
$$;
revoke all on function public.hub_ingest_customer_signal(jsonb) from public, anon, authenticated;
grant execute on function public.hub_ingest_customer_signal(jsonb) to service_role;
