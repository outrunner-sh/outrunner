-- Schema behaviour assertions. Each block raises an exception on failure, so
-- the script fails loudly under `psql -v ON_ERROR_STOP=1`.

\set QUIET on
set client_min_messages to notice;

insert into auth.users (id, email)
values ('11111111-1111-1111-1111-111111111111', 'owner@example.com'),
       ('22222222-2222-2222-2222-222222222222', 'other@example.com');

insert into projects (owner_id, github_repo_id, full_name, owner, name)
values ('11111111-1111-1111-1111-111111111111', 42,
        'immadsahin/runtime', 'immadsahin', 'runtime');

insert into projects (owner_id, github_repo_id, full_name, owner, name)
values ('22222222-2222-2222-2222-222222222222', 84,
        'other/runtime', 'other', 'runtime');

-- 1. A repo may be synced only once per owner.
do $$
begin
  insert into projects (owner_id, github_repo_id, full_name, owner, name)
  values ('11111111-1111-1111-1111-111111111111', 42,
          'immadsahin/runtime', 'immadsahin', 'runtime');
  raise exception 'FAIL: duplicate (owner, repo) was allowed';
exception when unique_violation then
  raise notice 'ok: duplicate repo rejected';
end $$;

-- 2. A workspace cannot reference a project belonging to another owner.
do $$
declare other_project_id uuid;
begin
  select id into other_project_id from projects where owner_id = '22222222-2222-2222-2222-222222222222';
  insert into workspaces (owner_id, project_id, branch)
  values ('11111111-1111-1111-1111-111111111111', other_project_id, 'cross-owner');
  raise exception 'FAIL: workspace accepted another owner''s project';
exception when foreign_key_violation then
  raise notice 'ok: cross-owner project rejected';
end $$;

-- 3. Only one live workspace per (project, branch).
insert into workspaces (owner_id, project_id, branch)
select '11111111-1111-1111-1111-111111111111', id, 'feat/x' from projects limit 1;

do $$
begin
  insert into workspaces (owner_id, project_id, branch)
  select '11111111-1111-1111-1111-111111111111', id, 'feat/x' from projects limit 1;
  raise exception 'FAIL: second live workspace on same branch was allowed';
exception when unique_violation then
  raise notice 'ok: duplicate live branch rejected';
end $$;

-- 4. Destroying a workspace frees the branch for reuse.
update workspaces set status = 'destroyed' where branch = 'feat/x';
insert into workspaces (owner_id, project_id, branch)
select '11111111-1111-1111-1111-111111111111', id, 'feat/x' from projects limit 1;

-- 5. Lifecycle actions use explicit in-progress enum values.
do $$
begin
  update workspaces set status = 'suspending'
  where branch = 'feat/x' and status <> 'destroyed';
  update workspaces set status = 'destroying'
  where branch = 'feat/x' and status <> 'destroyed';
  update workspaces set status = 'creating'
  where branch = 'feat/x' and status <> 'destroyed';
  raise notice 'ok: lifecycle transition states accepted';
end $$;

-- 6. At most one queued/running job per workspace.
insert into jobs (owner_id, workspace_id, prompt, status)
select '11111111-1111-1111-1111-111111111111', id, 'first', 'running'
from workspaces where status <> 'destroyed' limit 1;

do $$
begin
  insert into jobs (owner_id, workspace_id, prompt, status)
  select '11111111-1111-1111-1111-111111111111', id, 'second', 'queued'
  from workspaces where status <> 'destroyed' limit 1;
  raise exception 'FAIL: concurrent job in one workspace was allowed';
exception when unique_violation then
  raise notice 'ok: concurrent job rejected';
end $$;

-- 7. A finished job frees the slot.
update jobs set status = 'succeeded' where prompt = 'first';

-- 7a. Jobs default to Claude for backwards compatibility and accept Codex.
do $$
declare agent_name text;
begin
  insert into jobs (owner_id, workspace_id, prompt)
  select '11111111-1111-1111-1111-111111111111', id, 'default agent'
  from workspaces where status <> 'destroyed' limit 1
  returning agent into agent_name;
  if agent_name <> 'claude' then
    raise exception 'FAIL: job agent did not default to Claude';
  end if;
  update jobs set status = 'succeeded' where prompt = 'default agent';
  insert into jobs (owner_id, workspace_id, prompt, agent)
  select '11111111-1111-1111-1111-111111111111', id, 'codex agent', 'codex'
  from workspaces where status <> 'destroyed' limit 1;
  update jobs set status = 'succeeded' where prompt = 'codex agent';
  raise notice 'ok: job agent values accepted';
end $$;

do $$
begin
  insert into jobs (owner_id, workspace_id, prompt, agent)
  select '11111111-1111-1111-1111-111111111111', id, 'invalid agent', 'unknown'
  from workspaces where status <> 'destroyed' limit 1;
  raise exception 'FAIL: invalid job agent was allowed';
exception when check_violation then
  raise notice 'ok: invalid job agent rejected';
end $$;

-- 8. A job cannot reference a workspace belonging to another owner.
do $$
declare owner_workspace_id uuid;
begin
  select id into owner_workspace_id from workspaces where owner_id = '11111111-1111-1111-1111-111111111111' limit 1;
  insert into jobs (owner_id, workspace_id, prompt)
  values ('22222222-2222-2222-2222-222222222222', owner_workspace_id, 'cross-owner');
  raise exception 'FAIL: job accepted another owner''s workspace';
exception when foreign_key_violation then
  raise notice 'ok: cross-owner workspace rejected';
end $$;

-- 9. A finished job leaves room for the next queued job.
insert into jobs (owner_id, workspace_id, prompt, status)
select '11111111-1111-1111-1111-111111111111', id, 'second', 'queued'
from workspaces where status <> 'destroyed' limit 1;

-- 10. updated_at is maintained by trigger.
do $$
declare touched boolean;
begin
  update jobs set status = 'running' where prompt = 'second';
  select updated_at > created_at into touched from jobs where prompt = 'second';
  if not touched then
    raise exception 'FAIL: updated_at trigger did not fire';
  end if;
  raise notice 'ok: updated_at trigger fires';
end $$;

-- 11. Pull requests are owner-scoped and one-to-one with a workspace.
insert into pull_requests (
  owner_id, workspace_id, github_number, url, title, base_branch, head_branch
)
select
  '11111111-1111-1111-1111-111111111111', id, 7,
  'https://github.com/immadsahin/runtime/pull/7', 'Runtime test', 'main', 'feat/x'
from workspaces where owner_id = '11111111-1111-1111-1111-111111111111' limit 1;

do $$
declare workspace uuid;
begin
  select id into workspace from workspaces where owner_id = '11111111-1111-1111-1111-111111111111' limit 1;
  insert into pull_requests (
    owner_id, workspace_id, github_number, url, title, base_branch, head_branch
  ) values (
    '11111111-1111-1111-1111-111111111111', workspace, 8,
    'https://github.com/immadsahin/runtime/pull/8', 'Duplicate', 'main', 'feat/x'
  );
  raise exception 'FAIL: duplicate workspace pull request was allowed';
exception when unique_violation then
  raise notice 'ok: one pull request per workspace enforced';
end $$;

-- 12. RLS isolates rows by owner.
do $do$
begin
  if not exists (select 1 from pg_roles where rolname = 'authed') then
    create role authed nologin;
  end if;
  grant usage on schema public to authed;
  grant all on all tables in schema public to authed;
end $do$;

set role authed;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

do $$
declare n integer;
begin
  select count(*) into n from projects where owner_id = '11111111-1111-1111-1111-111111111111';
  if n <> 0 then
    raise exception 'FAIL: RLS leaked % project rows to another user', n;
  end if;
  select count(*) into n from workspaces where owner_id = '11111111-1111-1111-1111-111111111111';
  if n <> 0 then
    raise exception 'FAIL: RLS leaked % workspace rows', n;
  end if;
  select count(*) into n from jobs where owner_id = '11111111-1111-1111-1111-111111111111';
  if n <> 0 then
    raise exception 'FAIL: RLS leaked % job rows', n;
  end if;
  select count(*) into n from pull_requests where owner_id = '11111111-1111-1111-1111-111111111111';
  if n <> 0 then
    raise exception 'FAIL: RLS leaked % pull request rows', n;
  end if;
  raise notice 'ok: RLS hides other owners'' rows';
end $$;

-- 13. RLS rejects inserts that forge another owner.
do $$
begin
  insert into projects (owner_id, github_repo_id, full_name, owner, name)
  values ('11111111-1111-1111-1111-111111111111', 99, 'x/y', 'x', 'y');
  raise exception 'FAIL: forged owner_id insert was allowed';
exception when insufficient_privilege then
  raise notice 'ok: forged owner_id insert rejected';
end $$;

reset role;

-- 14. Settings → Sandbox: Outrunner's sandboxes by default, and nothing but
-- the two choices; a computer records its provider, unknown on older rows.
do $$
declare chosen text;
begin
  insert into user_credentials (user_id) values ('11111111-1111-1111-1111-111111111111')
    on conflict (user_id) do nothing;
  select sandbox into chosen from user_credentials where user_id = '11111111-1111-1111-1111-111111111111';
  if chosen <> 'outrunner' then
    raise exception 'FAIL: a user''s sandbox defaults to %, not outrunner', chosen;
  end if;
  begin
    update user_credentials set sandbox = 'elsewhere' where user_id = '11111111-1111-1111-1111-111111111111';
    raise exception 'FAIL: sandbox accepted a value that is neither choice';
  exception when check_violation then
    null;
  end;
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'runtime_computers' and column_name = 'provider' and is_nullable = 'YES'
  ) then
    raise exception 'FAIL: runtime_computers.provider is missing or not nullable';
  end if;
  raise notice 'ok: sandbox choice defaults to outrunner, is checked, and computers record a provider';
end $$;

-- 15. Box size: Small by default, and only the sizes the app knows.
do $$
declare size text;
begin
  insert into user_credentials (user_id) values ('11111111-1111-1111-1111-111111111111')
    on conflict (user_id) do nothing;
  select box_size into size from user_credentials where user_id = '11111111-1111-1111-1111-111111111111';
  if size <> 'small' then
    raise exception 'FAIL: box_size defaults to %, not small', size;
  end if;
  begin
    update user_credentials set box_size = 'huge' where user_id = '11111111-1111-1111-1111-111111111111';
    raise exception 'FAIL: box_size accepted a size the app does not know';
  exception when check_violation then
    null;
  end;
  raise notice 'ok: box size defaults to small and is checked';
end $$;

-- 16. Settings → Sandbox: the user's own Modal is a choice, on a token kept
-- sealed beside the Daytona key.
do $$
begin
  insert into user_credentials (user_id) values ('11111111-1111-1111-1111-111111111111')
    on conflict (user_id) do nothing;
  update user_credentials set sandbox = 'modal' where user_id = '11111111-1111-1111-1111-111111111111';
  if (select count(*) from information_schema.columns
      where table_name = 'user_credentials'
        and column_name in ('modal_token_ciphertext', 'modal_token_hint', 'modal_token_updated_at')) <> 3 then
    raise exception 'FAIL: user_credentials lacks the Modal token columns';
  end if;
  update user_credentials set sandbox = 'outrunner' where user_id = '11111111-1111-1111-1111-111111111111';
  raise notice 'ok: modal is a sandbox choice, with its token columns';
end $$;

-- 17. Settings → Providers: a user's own OpenRouter key, kept sealed beside their
-- other keys.
do $$
begin
  if (select count(*) from information_schema.columns
      where table_name = 'user_credentials'
        and column_name in ('openrouter_key_ciphertext', 'openrouter_key_hint', 'openrouter_key_updated_at')) <> 3 then
    raise exception 'FAIL: user_credentials lacks the OpenRouter key columns';
  end if;
  raise notice 'ok: user_credentials has the OpenRouter key columns';
end $$;

-- 18. Cloud hours: usage is the server's alone, one open interval per box, and
-- the reconciler's lease goes to one caller at a time.
set role authed;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

do $$
declare n integer;
begin
  -- RLS on with no policies: a user sees no usage, not even their own...
  select count(*) into n from compute_intervals;
  if n <> 0 then
    raise exception 'FAIL: a user can read compute_intervals';
  end if;
  -- ...and can't write any, which would forge their hours.
  begin
    insert into compute_intervals (owner_id, sandbox_id, cpu)
    values ('11111111-1111-1111-1111-111111111111', 'sb-forged', 2);
    raise exception 'FAIL: a user could insert into compute_intervals';
  exception when insufficient_privilege then
    null;
  end;
  begin
    insert into billing_leases (name, held_until) values ('reconcile', now() + interval '1 hour');
    raise exception 'FAIL: a user could take a billing lease';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok: users can neither read nor write cloud usage or leases';
end $$;

reset role;

do $$
begin
  insert into compute_intervals (owner_id, sandbox_id, cpu)
  values ('11111111-1111-1111-1111-111111111111', 'sb-1', 2);
  begin
    insert into compute_intervals (owner_id, sandbox_id, cpu)
    values ('11111111-1111-1111-1111-111111111111', 'sb-1', 2);
    raise exception 'FAIL: a box had two open intervals';
  exception when unique_violation then
    null;
  end;
  -- Once closed, the box can run again in a new one.
  update compute_intervals set ended_at = now() where sandbox_id = 'sb-1' and ended_at is null;
  insert into compute_intervals (owner_id, sandbox_id, cpu)
  values ('11111111-1111-1111-1111-111111111111', 'sb-1', 2);
  begin
    insert into compute_intervals (owner_id, sandbox_id, cpu, started_at, ended_at)
    values ('11111111-1111-1111-1111-111111111111', 'sb-2', 2, now(), now() - interval '1 minute');
    raise exception 'FAIL: an interval ended before it started';
  exception when check_violation then
    null;
  end;
  begin
    insert into compute_intervals (owner_id, sandbox_id, cpu) values ('11111111-1111-1111-1111-111111111111', 'sb-3', 0);
    raise exception 'FAIL: an interval had no vCPUs';
  exception when check_violation then
    null;
  end;
  raise notice 'ok: one open interval per box, and intervals are well-formed';
end $$;

do $$
begin
  if not claim_billing_lease('reconcile', 60) then
    raise exception 'FAIL: a free lease could not be taken';
  end if;
  if claim_billing_lease('reconcile', 60) then
    raise exception 'FAIL: a held lease was taken again';
  end if;
  update billing_leases set held_until = now() - interval '1 second' where name = 'reconcile';
  if not claim_billing_lease('reconcile', 60) then
    raise exception 'FAIL: an expired lease could not be taken';
  end if;
  if has_function_privilege('authenticated', 'claim_billing_lease(text, integer)', 'execute') then
    raise exception 'FAIL: a signed-in user may take a billing lease';
  end if;
  raise notice 'ok: a lease goes to one caller until it expires';
end $$;

-- 19. Stripe billing: users can neither see nor write billing, and a stored
-- subscription is for a plan Outrunner sells.
set role authed;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

do $$
declare n integer;
begin
  select count(*) into n from subscriptions;
  if n <> 0 then raise exception 'FAIL: a user can read subscriptions'; end if;
  select count(*) into n from billing_customers;
  if n <> 0 then raise exception 'FAIL: a user can read billing_customers'; end if;
  begin
    -- A user giving themselves a plan.
    insert into subscriptions (stripe_subscription_id, user_id, stripe_customer_id, status, plan,
                               current_period_start, current_period_end)
    values ('sub_forged', '11111111-1111-1111-1111-111111111111', 'cus_x', 'active', 'max', now(), now() + interval '1 month');
    raise exception 'FAIL: a user could insert a subscription';
  exception when insufficient_privilege then
    null;
  end;
  begin
    insert into billing_customers (user_id, stripe_customer_id) values ('11111111-1111-1111-1111-111111111111', 'cus_x');
    raise exception 'FAIL: a user could set their Stripe customer';
  exception when insufficient_privilege then
    null;
  end;
  begin
    insert into stripe_events (id, type) values ('evt_forged', 'invoice.paid');
    raise exception 'FAIL: a user could mark a Stripe event handled';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok: users can neither read nor write billing';
end $$;

reset role;

do $$
begin
  insert into billing_customers (user_id, stripe_customer_id) values ('11111111-1111-1111-1111-111111111111', 'cus_1');
  begin
    insert into billing_customers (user_id, stripe_customer_id) values ('22222222-2222-2222-2222-222222222222', 'cus_1');
    raise exception 'FAIL: two users shared a Stripe customer';
  exception when unique_violation then
    null;
  end;
  begin
    insert into subscriptions (stripe_subscription_id, user_id, stripe_customer_id, status, plan,
                               current_period_start, current_period_end)
    values ('sub_1', '11111111-1111-1111-1111-111111111111', 'cus_1', 'active', 'free', now(), now());
    raise exception 'FAIL: a subscription was stored for a plan Stripe does not sell';
  exception when check_violation then
    null;
  end;
  insert into subscriptions (stripe_subscription_id, user_id, stripe_customer_id, status, plan,
                             billing_interval, current_period_start, current_period_end)
  values ('sub_1', '11111111-1111-1111-1111-111111111111', 'cus_1', 'active', 'pro', 'month', now(), now() + interval '1 month');
  raise notice 'ok: one Stripe customer per user, and subscriptions are for a sold plan';
end $$;
