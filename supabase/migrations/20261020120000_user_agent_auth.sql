-- How each of a user's coding agents signs in (Settings → Providers, a card
-- per way): Claude Code on the user's subscription, their Mac's own login, or
-- an API key; Codex on ChatGPT, the Mac's own login, or an API key. One row
-- per user and agent, holding the pick only: the credentials stay where they
-- are (user_credentials' Claude slot, user_provider_keys), and none of them
-- is copied here. No row: the agent runs as it did before there was a pick
-- (lib/agents/resolve.ts).
--
-- The same treatment as the credentials it points at: RLS on with no policy
-- and every grant revoked, reached only by the service role through
-- lib/db/agent-auth.ts.
-- ---------------------------------------------------------------------------

create table if not exists user_agent_auth (
  user_id uuid not null references auth.users (id) on delete cascade,
  -- An id from lib/agents/registry.ts.
  agent text not null check (agent in ('claude', 'codex')),
  -- One of that agent's ways of signing in. Which ways an agent has is the
  -- app's to say; this only keeps out what no agent has.
  method text not null check (method in ('subscription', 'chatgpt', 'local', 'api-key')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, agent)
);

drop trigger if exists user_agent_auth_set_updated_at on user_agent_auth;
create trigger user_agent_auth_set_updated_at
  before update on user_agent_auth
  for each row execute function set_updated_at();

alter table user_agent_auth enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table user_agent_auth from anon, authenticated;
