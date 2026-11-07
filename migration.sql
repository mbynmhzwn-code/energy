-- اجرا در Supabase → SQL Editor (یک بار؛ بی‌خطر برای اجرای دوباره)

-- ۱) زمان یادآوری هر کاربر ربات (پیش‌فرض ۶ ساعت، برای همهٔ کاربران فعلی هم ۶ می‌ماند)
alter table public.bot_subscribers
  add column if not exists remind_hours integer not null default 6
    check (remind_hours between 1 and 168),
  add column if not exists awaiting_remind_until timestamptz;

-- ۲) اطلاعیه‌های آزاد (متن + عکس/فایل) از پنل مدیر
create table if not exists public.bot_broadcasts (
  id uuid primary key default gen_random_uuid(),
  title text not null default '',
  body text not null default '',
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.bot_broadcast_deliveries (
  broadcast_id uuid not null references public.bot_broadcasts(id) on delete cascade,
  chat_id bigint not null,
  created_at timestamptz not null default now(),
  primary key (broadcast_id, chat_id)
);

alter table public.bot_broadcasts enable row level security;
alter table public.bot_broadcast_deliveries enable row level security;

drop policy if exists "admin manage broadcasts" on public.bot_broadcasts;
create policy "admin manage broadcasts" on public.bot_broadcasts
  for all to authenticated using (true) with check (true);

drop policy if exists "admin read broadcast deliveries" on public.bot_broadcast_deliveries;
create policy "admin read broadcast deliveries" on public.bot_broadcast_deliveries
  for select to authenticated using (true);
-- Worker با service key کار می‌کند و از RLS عبور می‌کند.
