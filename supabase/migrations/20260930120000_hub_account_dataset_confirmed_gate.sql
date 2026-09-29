-- Customer Intelligence Inbox — Package 4: Confirmed-Gate for hub_account_dataset().
-- NOT YET APPLIED — shown for PO review, part of a joint Package 3+4
-- integration test/deployment step per your instruction.
--
-- Change 1: the customerSignals join now uses the EFFECTIVE, confirmed
-- account link (same expression Package 2 already established for
-- hub_inbox_dataset()) instead of the raw account_id column. Today this is
-- a no-op for every existing row (Package 1's bridge fix keeps account_id
-- and account_confirmed in lockstep for currently-matched signals), but it
-- is what prevents a genuinely unconfirmed signal (once Package 5 starts
-- creating them) from ever reaching an account's detail view — and
-- therefore its NBA approval control — before Gate 1 has run.
--
-- Change 2: two new per-signal fields, accountConfirmed and caseActive.
-- caseActive is computed via a case status lookup that, today, can never
-- evaluate to false (no case can exist yet — case creation isn't
-- implemented until a later package) — this is the architectural
-- preparation for case-based health recovery your Package 4 decision asked
-- for, wired in now so Package 9 doesn't require touching this function
-- again.
--
-- Nothing else changes: base 8-factor scoring, approve-action.js, the n8n
-- ingestion workflow, and every other field already returned are untouched.

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
        'deliveryAt', s.delivery_at, 'createdAt', s.created_at,
        'accountConfirmed', s.account_confirmed,
        'caseActive', s.case_id is null or exists(
          select 1 from public.cases c where c.case_id = s.case_id and c.status <> 'resolved'
        )
      ) order by s.created_at desc)
      from public.customer_signals s
      where (case when s.account_confirmed then coalesce(s.confirmed_account_id, s.account_id) else null end) = a.account_id
      ), '[]'::jsonb)
    ) order by a.source_order) from public.accounts a), '[]'::jsonb)
  ) from public.dataset_metadata m where m.id = 'hub';
$$;
