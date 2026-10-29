-- A project's MCP servers (an `environments` row: what the app calls a
-- Project). Every session of the project loads them in Claude Code and Codex,
-- beside the user's own (user_agent_config), whose win on a name both have
-- (lib/db/environment-mcp.ts, lib/runtime/session-setup.deps.ts).
--
-- A server is stdio, a command with its arguments and environment, or http,
-- a URL with headers. The environment's and headers' values are secrets,
-- treated as the project's variables are: one AES-256-GCM sealed JSON
-- object, {env, headers} (lib/crypto/secret-box.ts), the names kept beside
-- it for showing without opening it. RLS on with no policy and every grant
-- revoked: only the service role reaches it, through lib/db.
--
-- Names starting with "outrunner" are Outrunner's own servers' (a Mission's
-- tools, the desktop's), so a project can't take one.
-- ---------------------------------------------------------------------------

create table if not exists environment_mcp_servers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  environment_id uuid not null,
  name text not null
    check (name ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' and lower(name) not like 'outrunner%'),
  transport text not null check (transport in ('stdio', 'http')),
  command text check (command is null or char_length(command) between 1 and 1024),
  args text[] not null default '{}',
  url text check (url is null or char_length(url) between 1 and 2048),
  env_names text[] not null default '{}',
  header_names text[] not null default '{}',
  secrets_ciphertext text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint environment_mcp_servers_shape check (
    (transport = 'stdio' and command is not null and url is null and header_names = '{}')
    or (transport = 'http' and url is not null and command is null and args = '{}' and env_names = '{}')
  ),
  constraint environment_mcp_servers_environment_fkey
    foreign key (org_id, environment_id) references environments (org_id, id) on delete cascade
);

-- One server by a name in a project, whatever its case: both agents key
-- their servers by name.
create unique index if not exists environment_mcp_servers_name_unique
  on environment_mcp_servers (environment_id, lower(name));

-- Taken from the project, never chosen (as environment_repos_org).
create or replace function environment_mcp_servers_org()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  select org_id into new.org_id from environments where id = new.environment_id;
  return new;
end;
$$;

drop trigger if exists environment_mcp_servers_org on environment_mcp_servers;
create trigger environment_mcp_servers_org
  before insert or update of environment_id on environment_mcp_servers
  for each row execute function environment_mcp_servers_org();

drop trigger if exists environment_mcp_servers_set_updated_at on environment_mcp_servers;
create trigger environment_mcp_servers_set_updated_at
  before update on environment_mcp_servers
  for each row execute function set_updated_at();

alter table environment_mcp_servers enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table environment_mcp_servers from anon, authenticated;
