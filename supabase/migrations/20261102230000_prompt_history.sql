-- Corrected before this version applied in production: public.prompt_history
-- is an unrelated legacy table and must not be changed.
--
-- The prompts a user has sent, in any session, for the composer to recall:
-- ↑ in an empty composer steps back through them, Ctrl+R searches them
-- (lib/session/prompt-history.ts). The user's own, so they follow the user
-- from session to session and device to device, and no one else's.
--
-- Written by the browser as each prompt goes (POST /api/prompt-history),
-- best effort: a prompt missing here is only missing from recall. Kept to the
-- newest few hundred a user, the route pruning as it writes.

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
