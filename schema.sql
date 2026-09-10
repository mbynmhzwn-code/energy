-- Supabase setup for the Sharif Energy Engineering resource center.
-- Run this in Supabase -> SQL Editor.

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

-- Everyone can read published resources.
drop policy if exists "public read published notes" on public.notes;
create policy "public read published notes" on public.notes
for select using (published = true);

-- Authenticated users may insert/delete only after you restrict the table
-- to your admin user via the policies below. Replace ADMIN_EMAIL with your email.
-- The safest simple setup for one admin is to use the user id instead of email.

-- Create the storage bucket from Storage UI as: notes
-- Set it to Public if you want direct browser downloads.

-- Storage policies: only authenticated users can upload/delete.
-- For a single-admin site, tighten these further by checking auth.uid().
drop policy if exists "authenticated upload notes" on storage.objects;
create policy "authenticated upload notes" on storage.objects
for insert to authenticated with check (bucket_id = 'notes');

drop policy if exists "authenticated delete notes" on storage.objects;
create policy "authenticated delete notes" on storage.objects
for delete to authenticated using (bucket_id = 'notes');
