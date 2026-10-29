-- Long-term memory: what an agent noted to remember across sessions
-- (lib/memory), kept for the person whose session noted it, or shared with
-- their org. Every new session of theirs loads the newest notes beside its
-- learnings (lib/runtime/agent-context.ts), and its agent reads and adds to
-- them with `outrunner-session memory` and `remember` (lib/session-tools).
-- Nothing is mined from conversations: a note is there because an agent
-- wrote it, and the person sees and deletes it in Settings → Memory.
--
-- Read and written by the server alone (service role), which checks who may
-- do what (lib/memory/actions.ts): no policies.

create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  -- Who noted it (their session's user), and the org it is shared with;
  -- null keeps it theirs alone.
  user_id uuid not null references auth.users (id) on delete cascade,
  org_id uuid references public.organizations (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  -- The session that noted it; no foreign key, a session deleted since
  -- leaves the note standing.
  workspace_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists memories_user on public.memories (user_id, created_at desc) where org_id is null;
create index if not exists memories_org on public.memories (org_id, created_at desc) where org_id is not null;

alter table public.memories enable row level security;
