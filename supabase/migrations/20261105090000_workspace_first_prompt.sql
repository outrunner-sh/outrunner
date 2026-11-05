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
-- nothing else to send.
--
-- One per session, so on the row itself. RLS keeps it as private as the row
-- it is on (workspaces_owner_all: an owner reads their own, no one else's),
-- and the columns are revoked from the client roles below: only the server
-- writes or clears a kept prompt, through the service-role client
-- (lib/db/repositories.ts), never a user session.
-- ---------------------------------------------------------------------------

alter table workspaces
  add column if not exists first_prompt text
    check (first_prompt is null or char_length(first_prompt) between 1 and 100000),
  add column if not exists first_prompt_attachments text[] not null default '{}',
  add column if not exists first_prompt_idempotency_key text
    check (first_prompt_idempotency_key is null or length(first_prompt_idempotency_key) between 1 and 100);

revoke insert (first_prompt, first_prompt_attachments, first_prompt_idempotency_key)
  on workspaces from anon, authenticated;
revoke update (first_prompt, first_prompt_attachments, first_prompt_idempotency_key)
  on workspaces from anon, authenticated;
