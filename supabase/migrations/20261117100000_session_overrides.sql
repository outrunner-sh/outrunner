-- What one session was given for itself when it was started through the
-- API, beyond its project's (lib/session/session-overrides.ts): variables,
-- MCP servers and subagents, sealed together (lib/crypto/secret-box.ts) as
-- one {env, mcpServers, subagents}. Kept with the session, so a restore
-- sets its new box up with them again; gone with it.
create table if not exists session_overrides (
  workspace_id uuid primary key references workspaces (id) on delete cascade,
  overrides_ciphertext text not null,
  created_at timestamptz not null default now()
);

alter table session_overrides enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql. Written
-- and read by the server alone (lib/db/session-overrides.ts).
