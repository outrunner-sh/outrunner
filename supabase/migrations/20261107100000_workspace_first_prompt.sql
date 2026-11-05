-- A new session's first prompt, kept for it on the server while its box
-- starts. Until now it waited only in the tab that made it (sessionStorage,
-- hooks/use-create-session.ts), so a tab closed — a laptop shut, a browser
-- refreshed away — during startup lost it for good: the session came up with
-- nothing to do. The copy is written as the session is made, under the
-- idempotency key the prompt's every send names
-- (first_prompt_idempotency_key, not the claim's first_prompt_key of
-- 20261031190000), delivered once the box is ready — by setup itself or by
-- the session page, whichever holds the claim — and cleared once it has gone.
-- first_prompt_attachments rides with it: a prompt of files alone has
-- nothing else to send, so first_prompt may be empty ('').
--
-- One per session, so on the row itself, as private as the row: RLS keeps
-- reads owner-scoped (the SELECT policy on workspaces — workspaces_owner_all
-- until 20261106100000 splits it into workspaces_owner_read), and writes are
-- the server's alone, not by anything here but by that same
-- 20261106100000_workspaces_server_writes.sql, which revokes insert, update
-- and delete on the whole table from the client roles. A column-level revoke
-- would be a no-op beside it anyway: on Supabase the client roles hold a
-- table-level grant, and Postgres checks column privileges only in addition
-- to the table's. The server writes and clears a kept prompt through the
-- service-role client (lib/db/repositories.ts).
-- ---------------------------------------------------------------------------

alter table workspaces
  add column if not exists first_prompt text
    check (first_prompt is null or char_length(first_prompt) <= 100000),
  add column if not exists first_prompt_attachments text[] not null default '{}',
  add column if not exists first_prompt_idempotency_key text
    check (first_prompt_idempotency_key is null or length(first_prompt_idempotency_key) between 1 and 100);