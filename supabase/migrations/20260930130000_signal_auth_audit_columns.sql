-- Customer Intelligence Inbox — Auth integration: audit columns.
-- NOT YET APPLIED — part of the joint Package 3+4 integration
-- test/deployment step, together with the two prior prepared migrations.
--
-- Deliberately separate from confirmed_by_csm_id / reviewed_by_csm_id
-- (both existing, fachlich-zustaendiger CSM per PO decision — unchanged):
-- these two new columns record the REAL, Supabase-Auth-verified person who
-- clicked, per the PO's explicit "Audit unterscheidet tatsaechlichen
-- Benutzer und fachlich zustaendigen CSM" requirement. Nullable/additive —
-- no existing row or query is affected.

alter table public.customer_signals
  add column confirmed_by_user_id uuid references auth.users(id),
  add column reviewed_by_user_id uuid references auth.users(id);
