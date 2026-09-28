-- Preserve the existing account document shape and all scoring inputs.
-- Stable IDs and relationships are relational; nested demo facts stay JSONB.
create table public.csms (
  csm_id text primary key,
  source_order integer not null unique check (source_order >= 0),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  constraint csm_document_id check ((data ->> 'csmId') is not null and data ->> 'csmId' = csm_id)
);

create table public.accounts (
  account_id text primary key,
  csm_id text not null references public.csms(csm_id),
  source_order integer not null unique check (source_order >= 0),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  constraint account_document_id check ((data ->> 'accountId') is not null and data ->> 'accountId' = account_id),
  constraint account_document_csm check ((data ->> 'csmId') is not null and data ->> 'csmId' = csm_id)
);
create index accounts_csm_id_idx on public.accounts(csm_id);

create table public.dataset_metadata (
  id text primary key check (id = 'hub'),
  data jsonb not null check (jsonb_typeof(data) = 'object' and not (data ? 'accounts') and not (data ? 'csms'))
);

alter table public.csms enable row level security;
alter table public.accounts enable row level security;
alter table public.dataset_metadata enable row level security;

revoke all on public.csms, public.accounts, public.dataset_metadata from public, anon, authenticated, service_role;
grant select on public.csms, public.accounts, public.dataset_metadata to service_role;
create policy backend_read on public.csms for select to service_role using (true);
create policy backend_read on public.accounts for select to service_role using (true);
create policy backend_read on public.dataset_metadata for select to service_role using (true);

-- SECURITY INVOKER: does not bypass table permissions. A single SQL statement
-- provides a consistent dataset even while another transaction updates it.
create function public.hub_account_dataset()
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select m.data || jsonb_build_object(
    'csms', coalesce((select jsonb_agg(c.data order by c.source_order) from public.csms c), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(a.data order by a.source_order) from public.accounts a), '[]'::jsonb)
  ) from public.dataset_metadata m where m.id = 'hub';
$$;
revoke all on function public.hub_account_dataset() from public, anon, authenticated;
grant execute on function public.hub_account_dataset() to service_role;
comment on function public.hub_account_dataset() is 'Server-only account snapshot for the existing CS AI Hub; excludes future mailbox and approval data.';
