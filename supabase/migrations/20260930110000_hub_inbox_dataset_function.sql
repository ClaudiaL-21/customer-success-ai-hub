-- Customer Intelligence Inbox — Package 2: read-only inbox data function.
-- NOT YET APPLIED — shown for PO review per instruction.
--
-- Purpose: hub_account_dataset() structurally cannot surface signals with
-- account_id IS NULL (unknown/ambiguous senders), because it joins signals
-- INTO each account's own record. This new function returns a flat,
-- cross-account list of every valid signal — matched, unknown, and
-- ambiguous — which is exactly what the Inbox needs and what no existing
-- function provides today.
--
-- Design decisions made explicit here (not silent):
--
-- 1. "effective" accountId/accountName/csmId are computed from
--    account_confirmed: an unconfirmed signal's account fields are NULL in
--    the output, even if account_id happens to be set internally (bridge-fix
--    rows from Package 1 are already account_confirmed=true, so this only
--    matters once Package 5 starts inserting genuinely unconfirmed rows).
--    This is what "unbestaetigte Signale duerfen keine Health- oder
--    NBA-Wirkung erhalten" means at the data layer: the frontend/scoring
--    code is never even handed a usable account link for anything
--    unconfirmed, so it cannot accidentally treat it as active by mistake.
--
-- 2. sender_email is deliberately NOT included in the output. The existing
--    suggestion_evidence text field already gives the CSM enough to judge an
--    AI suggestion (a short quoted excerpt) without exposing the raw address.
--    This is a real scope decision, not an oversight — flagged for your
--    sign-off same as any other one in this package.
--
-- 3. No server-side filtering/pagination in this function (same pattern as
--    the existing hub_account_dataset(), which also returns one full JSON
--    blob) — sorting by recency is done here; filtering is left to the
--    frontend's existing state.filters mechanism in a later UI package.
--    PostgREST cannot filter a jsonb-returning RPC via query parameters
--    anyway, so this matches the codebase's existing pattern rather than
--    inventing a new one.
--
-- 4. Reuses existing accounts/csms tables and their `data` jsonb columns
--    exactly as hub_account_dataset() already does — no schema change here,
--    this migration only adds one new function plus its lockdown grants.

create or replace function public.hub_inbox_dataset()
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'signalId', s.signal_id,
      'createdAt', s.created_at,
      'threadId', s.thread_id,
      'topic', s.topic,
      'type', s.signal_type,
      'sentiment', s.sentiment,
      'urgency', s.urgency,
      'summary', s.summary,
      'evidence', s.evidence,
      'inboundCategory', s.inbound_category,
      'matchStatus', s.match_status,

      -- Effective, health/NBA-relevant account link — NULL unless confirmed.
      'accountConfirmed', s.account_confirmed,
      'accountId', eff.effective_account_id,
      'accountName', ea.data ->> 'accountName',
      'csmId', ea.csm_id,
      'csmName', ec.data ->> 'name',

      -- AI suggestion, always shown regardless of confirmation — this is
      -- exactly what Gate 1 (Confirm Account/Case) needs to render, and it
      -- is clearly a *different* field from the confirmed ones above.
      'suggestedAccountId', s.suggested_account_id,
      'suggestedAccountName', sa.data ->> 'accountName',
      'suggestionSource', s.suggestion_source,
      'suggestionEvidence', s.suggestion_evidence,

      'caseId', s.case_id,
      'processingStatus', s.processing_status,

      -- NBA/action fields — shown as proposed data regardless of account
      -- confirmation (the Inbox must show what's pending), but Gate 2's
      -- approval control is only ever wired up in the UI once Gate 1 has
      -- confirmed the account — that sequencing is a later UI package's
      -- responsibility, not this data function's.
      'actionType', s.action_type,
      'proposedAction', s.proposed_action,
      'proposedRationale', s.proposed_rationale,
      'actionSources', s.action_sources,
      'noMatchingSourceFound', s.no_matching_source_found,
      'reviewStatus', s.review_status,

      -- Included for transparency/debugging in the Inbox; computeHealthScore()
      -- itself is untouched by this package and still only reads signals via
      -- hub_account_dataset(), not this function.
      'healthDelta', s.health_delta,
      'healthRule', s.health_rule
    ) order by s.created_at desc
  ), '[]'::jsonb)
  from public.customer_signals s
  cross join lateral (
    select case when s.account_confirmed
      then coalesce(s.confirmed_account_id, s.account_id)
      else null end as effective_account_id
  ) eff
  left join public.accounts ea on ea.account_id = eff.effective_account_id
  left join public.csms ec on ec.csm_id = ea.csm_id
  left join public.accounts sa on sa.account_id = s.suggested_account_id;
$$;

revoke all on function public.hub_inbox_dataset() from public, anon, authenticated;
grant execute on function public.hub_inbox_dataset() to service_role;
