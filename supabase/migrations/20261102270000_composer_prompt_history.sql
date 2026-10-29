-- Also create the distinct composer table for databases that already recorded
-- 20261102230000 before its correction. Repeating it on fresh installs is safe.
-- No existing history is copied: public.prompt_history may contain unrelated
-- legacy data or an earlier composer's rows. Leave either intact and start
-- fresh recall in the distinct table.

create table if not exists public.composer_prompt_history (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  text text not null check (char_length(text) between 1 and 20000),
  created_at timestamptz not null default now()
);

-- Read newest first and pruned by id, which only grows: one index for both.
create index if not exists composer_prompt_history_owner_recent on public.composer_prompt_history (owner_id, id desc);

alter table public.composer_prompt_history enable row level security;

drop policy if exists composer_prompt_history_owner_all on public.composer_prompt_history;
create policy composer_prompt_history_owner_all on public.composer_prompt_history
  for all using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
