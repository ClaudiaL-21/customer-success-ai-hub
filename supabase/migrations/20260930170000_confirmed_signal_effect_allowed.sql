-- Sprint 15C Final Integration Fix — Root cause of "Confirmation could not
-- be saved. Please try again." on Gate 1 for an unmatched-at-ingestion
-- signal (finding from the final manual PO-UAT, 2026-09-30).
--
-- The unmatched_no_effect check constraint (20260929120000) predates the
-- confirm-time Health/NBA activation added in 20260930150000/the
-- api/confirm-signal-account.js activation logic. It only ever allowed
-- health_delta/review_status to be non-default when match_status='matched'
-- (an automatic match at ingestion) — there was no other path to activation
-- when it was written. api/confirm-signal-account.js's atomic PATCH for a
-- signal confirmed after the fact (match_status='unknown'/'ambiguous', but
-- account_confirmed now true) sets health_delta/review_status in that same
-- PATCH, which the constraint rejected outright: PostgREST returned a
-- non-2xx response, and api/_signal-store.js's patchSignalWhereUnconfirmed
-- surfaces any non-2xx PATCH as the generic 503 seen in the UI.
--
-- Fix, scoped to exactly this: the constraint now also allows the
-- account_confirmed=true case, alongside the original match_status='matched'
-- case. The principle it enforces is unchanged — a signal that is NEITHER
-- automatically matched NOR (now, or ever) confirmed by a human still cannot
-- carry a non-zero health_delta or non-null review_status. This is not a new
-- rule, it is the existing rule's condition corrected to the two ways a
-- signal can legitimately become "known" post-Sprint-15C-Final-Integration,
-- not just the one that existed when the constraint was first written.

alter table public.customer_signals drop constraint unmatched_no_effect;
alter table public.customer_signals add constraint unmatched_no_effect
  check (match_status = 'matched' or account_confirmed = true or (health_delta = 0 and review_status is null));
