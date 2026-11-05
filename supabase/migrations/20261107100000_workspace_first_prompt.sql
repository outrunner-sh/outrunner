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
-- 20261106100000_workspaces_server_writes.sql (#393), which revokes insert,
-- update and delete on the whole table from the client roles. A column-level
-- revoke would be a no-op beside it anyway: on Supabase the client roles
-- hold a table-level grant, and Postgres checks column privileges only in
-- addition to the table's.
--
-- That makes #393 a hard prerequisite: this migration must merge after it,
-- and refuses to run otherwise — the guard below fails the migrate loudly
-- while the client roles can still write workspaces, so the kept-prompt
-- columns can never exist on a database where a user session could write
-- them. Repeating the revoke here instead would break every user-scoped
-- write the app makes today (20261106100000 moves them to the service role
-- with it), and duplicate what #393 already carries. The server writes and
-- clears a kept prompt through the service-role client
-- (lib/db/repositories.ts).
-- ---------------------------------------------------------------------------

--
-- The guard asks for both halves of #393: its policy split (the `for all`
-- workspaces_owner_all gone, workspaces_owner_read in its place) and its
-- revokes (no client role left holding insert or update). The policy check
-- holds wherever the migrations ran, grants or not; the grant check is the
-- one that matters on Supabase, whose client roles hold every table's
-- privileges until a migration takes them away — as the verifier's stub
-- models (scripts/verify-migrations.sh), so it trips there too.
do $$
begin
  if exists (select 1 from pg_policies
             where schemaname = 'public' and tablename = 'workspaces' and policyname = 'workspaces_owner_all')
    or not exists (select 1 from pg_policies
                   where schemaname = 'public' and tablename = 'workspaces' and policyname = 'workspaces_owner_read') then
    raise exception 'workspaces still has its owner write policy: this migration must follow 20261106100000_workspaces_server_writes.sql (#393)';
  end if;
  if has_table_privilege('anon', 'workspaces', 'insert')
    or has_table_privilege('anon', 'workspaces', 'update')
    or has_table_privilege('authenticated', 'workspaces', 'insert')
    or has_table_privilege('authenticated', 'workspaces', 'update') then
    raise exception 'workspaces is still writable by the client roles: this migration must follow 20261106100000_workspaces_server_writes.sql (#393)';
  end if;
end $$;

alter table workspaces
  add column if not exists first_prompt text
    check (first_prompt is null or char_length(first_prompt) <= 100000),
  add column if not exists first_prompt_attachments text[] not null default '{}',
  add column if not exists first_prompt_idempotency_key text
    check (first_prompt_idempotency_key is null or length(first_prompt_idempotency_key) between 1 and 100);
