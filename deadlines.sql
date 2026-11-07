-- اجرا در Supabase > SQL Editor
-- نوع هر رویداد را ذخیره می‌کند؛ موارد قدیمی به‌طور پیش‌فرض تمرین/پروژه می‌شوند.
alter table public.deadlines
add column if not exists event_type text not null default 'assignment';

alter table public.deadlines
drop constraint if exists deadlines_event_type_check;

alter table public.deadlines
add constraint deadlines_event_type_check
check (event_type in ('assignment', 'quiz', 'exam'));

-- اگر خواستی نوع موارد قدیمی را دستی اصلاح کنی، نمونه:
-- update public.deadlines set event_type = 'quiz' where id = 'شناسه-مورد';
-- update public.deadlines set event_type = 'exam' where id = 'شناسه-مورد';
