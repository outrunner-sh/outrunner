-- How a person's chats take what they send while the agent works (Settings →
-- Account → Chats). steer_follow_ups, on unless they turn it off: a message
-- sent mid-turn goes straight into the running turn, which the agent takes in
-- at its next step, rather than waiting in the queue for the turn to end. No
-- row is the defaults.

create table if not exists public.user_chat_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  steer_follow_ups boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.user_chat_preferences enable row level security;

drop policy if exists user_chat_preferences_owner_all on public.user_chat_preferences;
create policy user_chat_preferences_owner_all on public.user_chat_preferences
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
