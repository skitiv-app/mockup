-- ============================================================
-- Mockup Studio — Supabase schema (Phase 2)
-- Run once in the Supabase SQL editor.
-- Assumes Auth0 is connected as a Third-Party Auth provider, so
-- auth.jwt() resolves Auth0 tokens (org_id + namespaced roles claim).
-- ============================================================

-- ---------- Tables ----------
create table if not exists public.mockups (
  id          text primary key,
  org_id      text not null,           -- Auth0 organization id
  created_by  text,                     -- Auth0 sub of creator (info only)
  name        text not null,
  image_path  text not null,           -- "{org_id}/{id}.png" in the mockups bucket
  width       int  not null,
  height      int  not null,
  tone        text default 'light',
  brand       text default 'Comfort Colors',
  placements  jsonb not null default '{}'::jsonb,   -- the frames per shape
  locked      boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table if not exists public.org_state (
  org_id     text primary key,
  presets    jsonb,
  settings   jsonb,
  updated_at timestamptz not null default now()
);

alter table public.mockups   enable row level security;
alter table public.org_state enable row level security;

-- ---------- Helper: is the caller an owner of the current org? ----------
create or replace function public.is_owner()
returns boolean language sql stable as $$
  select coalesce(
    (auth.jwt() -> 'https://mockupstudio/roles') ? 'owner',
    false
  );
$$;

-- ---------- RLS: mockups ----------
drop policy if exists "org read"     on public.mockups;
drop policy if exists "owner insert" on public.mockups;
drop policy if exists "org update"   on public.mockups;
drop policy if exists "org delete"   on public.mockups;

create policy "org read" on public.mockups
  for select using (org_id = auth.jwt()->>'org_id');

create policy "owner insert" on public.mockups
  for insert with check (
    org_id = auth.jwt()->>'org_id' and public.is_owner()
  );

create policy "org update" on public.mockups
  for update using (org_id = auth.jwt()->>'org_id' and public.is_owner())
  with check (org_id = auth.jwt()->>'org_id' and public.is_owner());

create policy "org delete" on public.mockups
  for delete using (org_id = auth.jwt()->>'org_id');

-- ---------- RLS: org_state (owner writes, members read) ----------
drop policy if exists "state read"  on public.org_state;
drop policy if exists "state write" on public.org_state;

create policy "state read" on public.org_state
  for select using (org_id = auth.jwt()->>'org_id');

create policy "state write" on public.org_state
  for all using (org_id = auth.jwt()->>'org_id' and public.is_owner())
  with check (org_id = auth.jwt()->>'org_id' and public.is_owner());

-- ---------- Trigger: members cannot unlock ----------
create or replace function public.block_member_unlock()
returns trigger language plpgsql as $$
begin
  if not public.is_owner()
     and old.locked = true and new.locked = false then
    raise exception 'Members are not allowed to unlock mockups';
  end if;
  return new;
end $$;

drop trigger if exists member_unlock_guard on public.mockups;
create trigger member_unlock_guard
  before update on public.mockups
  for each row execute function public.block_member_unlock();

-- ---------- Storage policies (bucket: mockups, folder = org_id) ----------
-- Create the bucket first in the Storage UI (name: mockups, Private).
drop policy if exists "org files read"    on storage.objects;
drop policy if exists "owner files write" on storage.objects;
drop policy if exists "org files delete"  on storage.objects;

create policy "org files read" on storage.objects
  for select using (
    bucket_id = 'mockups'
    and (storage.foldername(name))[1] = auth.jwt()->>'org_id'
  );

create policy "owner files write" on storage.objects
  for insert with check (
    bucket_id = 'mockups'
    and (storage.foldername(name))[1] = auth.jwt()->>'org_id'
    and public.is_owner()
  );

create policy "org files delete" on storage.objects
  for delete using (
    bucket_id = 'mockups'
    and (storage.foldername(name))[1] = auth.jwt()->>'org_id'
  );
