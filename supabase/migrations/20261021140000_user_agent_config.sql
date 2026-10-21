-- A user's own agent setup, imported from their Mac for their cloud
-- computers: an archive of their CLAUDE.md, skills, subagents, slash commands
-- and Codex AGENTS.md in the snapshot bucket (under their archives/ folder),
-- and Claude's MCP servers and plugin settings. One per user; an import
-- replaces it.
--
-- MCP servers carry keys (headers, environment), so the same treatment as
-- user_credentials: RLS on with no policy and every grant revoked, reached
-- only by the service role through lib/db/agent-config.ts. They are sealed
-- (lib/crypto/secret-box.ts); their names are kept beside them.
-- ---------------------------------------------------------------------------

create table if not exists user_agent_config (
  user_id uuid primary key references auth.users (id) on delete cascade,
  archive_path text,
  archive_sha256 text check (archive_sha256 is null or archive_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  archive_size bigint,
  items text[] not null default '{}',
  mcp_ciphertext text,
  mcp_names text[] not null default '{}',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_agent_config_archive_ck
    check ((archive_path is null) = (archive_sha256 is null))
);

drop trigger if exists user_agent_config_set_updated_at on user_agent_config;
create trigger user_agent_config_set_updated_at
  before update on user_agent_config
  for each row execute function set_updated_at();

alter table user_agent_config enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table user_agent_config from anon, authenticated;
