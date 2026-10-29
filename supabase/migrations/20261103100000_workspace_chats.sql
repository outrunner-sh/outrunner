-- A session's chats other than its main one (the session itself): each a
-- conversation of its own, on its own agent and model, in the session's
-- worktree. The runtime-agent runs them; this is their record for the page's
-- chat switcher and the API: their names, their agents and models, and where
-- a fork came from.
--
-- kind 'side' is a side chat (/btw): a fork that asks about the chat it came
-- from without touching its turn. forked_from is that chat: 'main' or another
-- chat's id. A chat is deleted outright, its agent stopped; the conversation
-- it had stays on the box.
--
-- main_chat_name names a session's main chat once it is renamed; null is
-- "Main".

create table if not exists public.workspace_chats (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  agent text not null check (agent in ('claude', 'codex')),
  kind text not null default 'chat' check (kind in ('chat', 'side')),
  forked_from text,
  model_provider text,
  model_id text,
  model_effort text,
  created_at timestamptz not null default now()
);

create index if not exists workspace_chats_workspace on public.workspace_chats (workspace_id, created_at);

alter table public.workspace_chats enable row level security;

drop policy if exists workspace_chats_owner_all on public.workspace_chats;
create policy workspace_chats_owner_all on public.workspace_chats
  for all using (auth.uid() = owner_id)
  with check (
    auth.uid() = owner_id
    and exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = auth.uid())
  );

alter table public.workspaces
  add column if not exists main_chat_name text
    check (main_chat_name is null or char_length(main_chat_name) between 1 and 80);
