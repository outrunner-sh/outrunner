-- The mode a session's prompts go in: build (its own: bypassPermissions on a
-- Runtime Computer) or plan, where its agent reads and proposes a plan rather
-- than changing anything (Claude's --permission-mode plan, Codex read-only).
-- Written by the message route each time a prompt goes in another mode, so
-- the session opens in the mode it was left in, on any device, and a box that
-- lost its record of it (a restore) is put back in it by the next prompt.
--
-- Null is build: every session from before this, and one never planned.

alter table workspaces
  add column if not exists session_mode text
    check (session_mode is null or session_mode in ('build', 'plan'));
