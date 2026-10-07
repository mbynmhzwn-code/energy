-- Supabase setup for the Sharif Energy Engineering resource center.
-- Run this whole file in Supabase -> SQL Editor.

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  course text not null,
  type text not null default 'جزوه',
  description text default '',
  file_path text not null,
  file_url text not null,
  published boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.notes enable row level security;

drop policy if exists "public read published notes" on public.notes;
create policy "public read published notes" on public.notes
for select using (published = true);

drop policy if exists "authenticated insert notes" on public.notes;
create policy "authenticated insert notes" on public.notes
for insert to authenticated with check (true);

drop policy if exists "authenticated delete notes" on public.notes;
create policy "authenticated delete notes" on public.notes
for delete to authenticated using (true);

-- =========================================================
-- DEADLINES
-- =========================================================

create table if not exists public.deadlines (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  course text not null,
  description text default '',
  due_at timestamptz not null,
  submit_place text default '',
  submit_url text default '',
  image_path text default '',
  image_url text default '',
  published boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.deadlines enable row level security;

drop policy if exists "public read published deadlines" on public.deadlines;
create policy "public read published deadlines" on public.deadlines
for select using (published = true);

drop policy if exists "authenticated insert deadlines" on public.deadlines;
create policy "authenticated insert deadlines" on public.deadlines
for insert to authenticated with check (true);

drop policy if exists "authenticated update deadlines" on public.deadlines;
create policy "authenticated update deadlines" on public.deadlines
for update to authenticated using (true) with check (true);

drop policy if exists "authenticated delete deadlines" on public.deadlines;
create policy "authenticated delete deadlines" on public.deadlines
for delete to authenticated using (true);

-- =========================================================
-- STORAGE
-- =========================================================

-- Existing notes bucket:
-- Create the bucket "notes" from Supabase Storage if you have not already done so.
-- It should be Public if you want direct browser downloads.

-- New bucket for question/deadline images:
insert into storage.buckets (id, name, public)
values ('deadline-images', 'deadline-images', true)
on conflict (id) do update set public = true;

drop policy if exists "public read deadline images" on storage.objects;
create policy "public read deadline images"
on storage.objects for select
using (bucket_id = 'deadline-images');

drop policy if exists "authenticated upload deadline images" on storage.objects;
create policy "authenticated upload deadline images"
on storage.objects for insert to authenticated
with check (bucket_id = 'deadline-images');

drop policy if exists "authenticated delete deadline images" on storage.objects;
create policy "authenticated delete deadline images"
on storage.objects for delete to authenticated
using (bucket_id = 'deadline-images');

-- Existing notes storage policies:
drop policy if exists "authenticated upload notes" on storage.objects;
create policy "authenticated upload notes"
on storage.objects for insert to authenticated
with check (bucket_id = 'notes');

drop policy if exists "authenticated delete notes" on storage.objects;
create policy "authenticated delete notes"
on storage.objects for delete to authenticated
using (bucket_id = 'notes');
