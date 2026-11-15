-- ArtExplorer Cashbook cloud tables.
-- Run this in the Supabase SQL Editor before connecting the app.

create table if not exists public.cashbook_entries (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  payload jsonb not null,
  updated_at_ms bigint not null,
  primary key (owner_id, id)
);

create table if not exists public.cashbook_lenders (
  owner_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  payload jsonb not null,
  updated_at_ms bigint not null,
  primary key (owner_id, id)
);

alter table public.cashbook_entries enable row level security;
alter table public.cashbook_lenders enable row level security;

revoke all on table public.cashbook_entries from anon;
revoke all on table public.cashbook_lenders from anon;
grant select, insert, update, delete on table public.cashbook_entries to authenticated;
grant select, insert, update, delete on table public.cashbook_lenders to authenticated;

drop policy if exists "Owners can access their cashbook entries" on public.cashbook_entries;
create policy "Owners can access their cashbook entries"
  on public.cashbook_entries
  for all
  to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "Owners can access their cashbook lenders" on public.cashbook_lenders;
create policy "Owners can access their cashbook lenders"
  on public.cashbook_lenders
  for all
  to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
