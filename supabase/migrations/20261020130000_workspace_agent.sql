-- The coding agent a session runs: Claude Code or Codex
-- (lib/agents/registry.ts). Picked when the session is made, by its first
-- model (lib/runtime/session-models.ts agentOf), and kept: a session's model
-- can change only to another its agent runs. Every session before this ran
-- Claude Code.
alter table workspaces
  add column if not exists agent text not null default 'claude'
  check (agent in ('claude', 'codex'));
