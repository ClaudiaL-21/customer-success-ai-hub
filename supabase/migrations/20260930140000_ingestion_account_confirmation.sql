-- Customer Intelligence Inbox — Package 5: switch ingestion to the new
-- account-confirmation process.
--
-- The only behavioral change from the Package 1 bridge fix: account_confirmed
-- is now ALWAYS false for a newly ingested signal, even for an exact
-- account_contacts match. The exact match is no longer silently trusted —
-- it becomes a high-confidence SUGGESTION (suggestion_source='contact_match',
-- suggested_account_id=the matched account) that Gate 1 must confirm before
-- it can affect Health or NBA. This is what closes the bridge-fix window
-- Package 1 explicitly opened "until Package 5 tightens this."
--
-- account_id itself is still populated on an exact match (unchanged) — it
-- remains the raw, deterministic match fact used for match_status and for
-- Gate 1 to default its suggestion to. Only its ability to affect anything
-- on its own, without human confirmation, is removed here.
--
-- Unknown/ambiguous senders: completely unchanged behavior (account_id null,
-- no NBA, health_delta 0) — they were never auto-confirmed and still aren't.
--
-- No change to: match_status logic, health_delta calculation, NBA proposal
-- generation for matched risk/growth signals (still generated and stored —
-- simply not reachable via Gate 2 until Gate 1 confirms, per the
-- hub_account_dataset() join fix applied together with this migration),
-- the n8n Email Signal Ingestion workflow itself, or the Approval workflow.

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
    case when matches = 1 and kind in ('risk','growth') then payload ->> 'proposedAction' else null end,
    case when matches = 1 and kind in ('risk','growth') then payload ->> 'proposedRationale' else null end,
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
