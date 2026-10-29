-- Learnings: short instructions every new session loads, kept by a team or
-- by one person (lib/learnings). An org's learnings are its members' to read
-- and its admins' to write; a person's are theirs alone, in every org they
-- work in. Each session's box gets the ones for its user and org as a managed
-- block in Claude's CLAUDE.md and Codex's AGENTS.md (lib/learnings/agent-context.ts).
--
-- A learning is either active (loaded) or suggested: an agent's suggestion,
-- or a member's for the org, waiting for someone who may write it to accept
-- it. Dismissing a suggestion deletes it.
--
-- Read and written by the server alone (service role), which checks who may
-- do what (lib/learnings/actions.ts): no policies.

create table if not exists public.learnings (
  id uuid primary key default gen_random_uuid(),
  -- Exactly one of the two: the org it is the team's in, or the person it
  -- is the own of.
  org_id uuid references public.organizations (id) on delete cascade,
  user_id uuid references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  body text not null check (char_length(body) between 1 and 2000),
  status text not null default 'active' check (status in ('active', 'suggested')),
  created_by uuid references auth.users (id) on delete set null,
  -- The session whose agent suggested it, for the page to link; no foreign
  -- key, as a session deleted since leaves the suggestion standing.
  suggested_in uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint learnings_one_scope check ((org_id is null) <> (user_id is null))
);

create index if not exists learnings_org on public.learnings (org_id, status, created_at) where org_id is not null;
create index if not exists learnings_user on public.learnings (user_id, status, created_at) where user_id is not null;

alter table public.learnings enable row level security;
