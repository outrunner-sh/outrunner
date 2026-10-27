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
                               current_period_start, current_period_end, synced_at)
    values ('sub_forged', '11111111-1111-1111-1111-111111111111', 'cus_x', 'active', 'max', now(), now() + interval '1 month', now());
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
                               current_period_start, current_period_end, synced_at)
    values ('sub_1', '11111111-1111-1111-1111-111111111111', 'cus_1', 'active', 'free', now(), now(), now());
    raise exception 'FAIL: a subscription was stored for a plan Stripe does not sell';
  exception when check_violation then
    null;
  end;
  insert into subscriptions (stripe_subscription_id, user_id, stripe_customer_id, status, plan,
                             billing_interval, current_period_start, current_period_end, synced_at)
  values ('sub_1', '11111111-1111-1111-1111-111111111111', 'cus_1', 'active', 'pro', 'month', now(), now() + interval '1 month', now());
  raise notice 'ok: one Stripe customer per user, and subscriptions are for a sold plan';
end $$;

-- 20. The model allowance's state, beside the user's key.
do $$
begin
  if (select count(*) from information_schema.columns
      where table_name = 'user_credentials'
        and column_name in ('neev_allowance_period', 'neev_allowance_plan',
                            'neev_allowance_baseline_usd', 'neev_allowance_limit_usd')) <> 4 then
    raise exception 'FAIL: user_credentials lacks the model allowance columns';
  end if;
  raise notice 'ok: user_credentials has the model allowance columns';
end $$;

-- 20. A plan's box cap is enforced inside the claim, and only where a box
-- would start: a claim that reuses its project's ready box passes at the
-- cap; one that would start another box is refused; the owner's own Daytona
-- doesn't count; and a null cap remains uncapped for an exempt start.
-- Whatever role an earlier block left, seed as the superuser.
reset role;

insert into projects (owner_id, github_repo_id, full_name, owner, name)
values ('11111111-1111-1111-1111-111111111111', 142, 'immadsahin/runtime-b', 'immadsahin', 'runtime-b'),
       ('11111111-1111-1111-1111-111111111111', 143, 'immadsahin/runtime-c', 'immadsahin', 'runtime-c'),
       ('11111111-1111-1111-1111-111111111111', 144, 'immadsahin/runtime-d', 'immadsahin', 'runtime-d');

insert into runtime_computers (owner_id, project_id, status, daytona_sandbox_id)
select '11111111-1111-1111-1111-111111111111', id, 'ready', 'box-cap-a'
from projects where owner_id = '11111111-1111-1111-1111-111111111111' and github_repo_id = 42;
insert into runtime_computers (owner_id, project_id, status, daytona_sandbox_id)
select '11111111-1111-1111-1111-111111111111', id, 'ready', 'box-cap-b'
from projects where owner_id = '11111111-1111-1111-1111-111111111111' and github_repo_id = 142;

set role authed;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

do $$
declare
  ready_project uuid;
  fresh_project uuid;
  another_project uuid;
  claimed record;
begin
  select id into ready_project from projects where owner_id = '11111111-1111-1111-1111-111111111111' and github_repo_id = 42;
  select id into fresh_project from projects where owner_id = '11111111-1111-1111-1111-111111111111' and github_repo_id = 143;
  select id into another_project from projects where owner_id = '11111111-1111-1111-1111-111111111111' and github_repo_id = 144;

  -- Reusing the project's ready box passes at the cap: no box would start.
  select * into claimed from claim_runtime_computer(ready_project, 'agent-secret-1', 'v1', 1);
  if claimed.should_provision then
    raise exception 'FAIL: a ready box was said to need provision';
  end if;

  -- Starting another box is refused.
  begin
    perform claim_runtime_computer(fresh_project, 'agent-secret-2', 'v1', 2);
    raise exception 'FAIL: a claim beyond the plan cap was allowed';
  exception when others then
    if SQLSTATE <> 'P4BX1' then
      raise;
    end if;
  end;

  -- The owner's own Daytona doesn't count toward the cap.
  update runtime_computers set provider = 'user-daytona' where daytona_sandbox_id = 'box-cap-b';
  perform claim_runtime_computer(fresh_project, 'agent-secret-3', 'v1', 2);
  if not exists (select 1 from runtime_computers where project_id = fresh_project and status = 'provisioning') then
    raise exception 'FAIL: the claim did not start a box within the cap';
  end if;

  -- A null cap is no cap: the deployment's owners.
  perform claim_runtime_computer(another_project, 'agent-secret-4', 'v1', null);
  if not exists (select 1 from runtime_computers where project_id = another_project and status = 'provisioning') then
    raise exception 'FAIL: an uncapped claim did not start a box';
  end if;

  -- Keep the SQL count aligned with the TypeScript cases in
  -- test/billing-limits.test.ts: ready and fresh provisioning count, stale
  -- provisioning and the user's own Daytona/Modal do not.
  update runtime_computers
  set status = 'stopped'
  where owner_id = '11111111-1111-1111-1111-111111111111';
  if live_metered_computers('11111111-1111-1111-1111-111111111111') <> 0 then
    raise exception 'FAIL: stopped boxes were counted';
  end if;
  update runtime_computers
  set status = 'ready', provider = null, updated_at = now()
  where daytona_sandbox_id = 'box-cap-a';
  if live_metered_computers('11111111-1111-1111-1111-111111111111') <> 1 then
    raise exception 'FAIL: a ready Outrunner box was not counted';
  end if;

  update runtime_computers
  set status = 'provisioning', updated_at = now() - interval '1 minute'
  where daytona_sandbox_id = 'box-cap-a';
  if live_metered_computers('11111111-1111-1111-1111-111111111111') <> 1 then
    raise exception 'FAIL: a fresh provisioning box was not counted';
  end if;

  update runtime_computers
  set status = 'ready', provider = 'user-daytona'
  where daytona_sandbox_id = 'box-cap-a';
  if live_metered_computers('11111111-1111-1111-1111-111111111111') <> 0 then
    raise exception 'FAIL: a user-owned Daytona box was counted';
  end if;

  update runtime_computers
  set provider = 'user-modal'
  where daytona_sandbox_id = 'box-cap-a';
  if live_metered_computers('11111111-1111-1111-1111-111111111111') <> 0 then
    raise exception 'FAIL: a user-owned Modal box was counted';
  end if;

  raise notice 'ok: the plan''s box cap holds in the claim, where a box would start';
end $$;

reset role;

-- A provisioning box whose provision died holds no slot. Backdated with the
-- updated_at trigger off: it stamps every update, so the box always read fresh.
alter table runtime_computers disable trigger runtime_computers_set_updated_at;
update runtime_computers
set status = 'provisioning', provider = null, updated_at = now() - interval '11 minutes'
where daytona_sandbox_id = 'box-cap-a';
alter table runtime_computers enable trigger runtime_computers_set_updated_at;

do $$
begin
  if live_metered_computers('11111111-1111-1111-1111-111111111111') <> 0 then
    raise exception 'FAIL: a stale provisioning box was counted';
  end if;
  raise notice 'ok: a stale provisioning box holds no slot';
end $$;

-- 21. Each session's own box (20261023130000_workspace_computers.sql): claimed
-- by its workspace, one per workspace, apart from its project's shared box,
-- and only by the workspace's owner. The plan's cap holds here too.
insert into workspaces (id, owner_id, project_id, branch)
select '33333333-3333-3333-3333-333333333331'::uuid, owner_id, id, 'own-box-1'
from projects where owner_id = '11111111-1111-1111-1111-111111111111' and github_repo_id = 143;
insert into workspaces (id, owner_id, project_id, branch)
select '33333333-3333-3333-3333-333333333332'::uuid, owner_id, id, 'own-box-2'
from projects where owner_id = '11111111-1111-1111-1111-111111111111' and github_repo_id = 143;
insert into workspaces (id, owner_id, project_id, branch)
select '33333333-3333-3333-3333-333333333333'::uuid, owner_id, id, 'not-yours'
from projects where owner_id = '22222222-2222-2222-2222-222222222222' limit 1;

-- The claim is granted to signed-in users only, which authed stands for.
grant authenticated to authed;
set role authed;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

do $$
declare
  first_claim record;
  again record;
  second_claim record;
  shared_claim record;
  project uuid;
begin
  select project_id into project from workspaces where id = '33333333-3333-3333-3333-333333333331';

  select * into first_claim from claim_workspace_computer('33333333-3333-3333-3333-333333333331', 's-1', 'v1', null);
  if not first_claim.should_provision then
    raise exception 'FAIL: a session''s first claim did not start its box';
  end if;
  select * into again from claim_workspace_computer('33333333-3333-3333-3333-333333333331', 's-2', 'v1', null);
  if again.should_provision or again.runtime_computer_id <> first_claim.runtime_computer_id then
    raise exception 'FAIL: a second claim for one session started another box';
  end if;

  select * into second_claim from claim_workspace_computer('33333333-3333-3333-3333-333333333332', 's-3', 'v1', null);
  if not second_claim.should_provision or second_claim.runtime_computer_id = first_claim.runtime_computer_id then
    raise exception 'FAIL: two sessions of one project share a box';
  end if;

  -- The project's shared box is another row, never a session's own.
  select * into shared_claim from claim_runtime_computer(project, 's-4', 'v1', null);
  if shared_claim.runtime_computer_id in (first_claim.runtime_computer_id, second_claim.runtime_computer_id) then
    raise exception 'FAIL: the project''s shared claim returned a session''s own box';
  end if;
  if (select workspace_id from runtime_computers where id = first_claim.runtime_computer_id)
     <> '33333333-3333-3333-3333-333333333331' then
    raise exception 'FAIL: a session''s box does not record its workspace';
  end if;

  -- A box stopped (paused while idle) is claimed back on the same row.
  update runtime_computers set status = 'stopped' where id = first_claim.runtime_computer_id;
  select * into again from claim_workspace_computer('33333333-3333-3333-3333-333333333331', 's-5', 'v1', null);
  if not again.should_provision or again.runtime_computer_id <> first_claim.runtime_computer_id then
    raise exception 'FAIL: a stopped box was not claimed back on its own row';
  end if;

  -- Starting a session's box past the plan's cap is refused.
  update runtime_computers set status = 'ready' where owner_id = '11111111-1111-1111-1111-111111111111';
  update runtime_computers set status = 'stopped' where id = second_claim.runtime_computer_id;
  begin
    perform claim_workspace_computer('33333333-3333-3333-3333-333333333332', 's-6', 'v1', 1);
    raise exception 'FAIL: a session''s box started past the plan''s cap';
  exception when others then
    if SQLSTATE <> 'P4BX1' then
      raise;
    end if;
  end;

  begin
    perform claim_workspace_computer('33333333-3333-3333-3333-333333333333', 's-7', 'v1', null);
    raise exception 'FAIL: a box was claimed for another owner''s session';
  exception when others then
    if SQLERRM <> 'workspace not found' then
      raise;
    end if;
  end;
  -- An ended session gets no box back (20261023140000).
  update workspaces set status = 'destroyed' where id = '33333333-3333-3333-3333-333333333332';
  begin
    perform claim_workspace_computer('33333333-3333-3333-3333-333333333332', 's-8', 'v1', null);
    raise exception 'FAIL: a box was claimed for an ended session';
  exception when others then
    if SQLERRM <> 'workspace not found' then
      raise;
    end if;
  end;
  raise notice 'ok: each session claims a box of its own, apart from its project''s shared one';
end $$;

reset role;

do $$
begin
  begin
    insert into runtime_computers (owner_id, project_id, workspace_id)
    select owner_id, project_id, id from workspaces where id = '33333333-3333-3333-3333-333333333331';
    raise exception 'FAIL: a session got a second box';
  exception when unique_violation then
    null;
  end;
  if has_function_privilege('anon', 'claim_workspace_computer(uuid, text, text, integer)', 'execute') then
    raise exception 'FAIL: a signed-out caller may claim a box';
  end if;
  raise notice 'ok: one box per session, and only signed-in callers may claim one';
end $$;

-- 23. The warm pool (20261025120000): a project's pooled box is handed to one
-- new session, of its owner, made by the provider asked for; one pooled box
-- per project; and it never counts toward the plan's cap.
insert into workspaces (id, owner_id, project_id, branch)
select '44444444-4444-4444-4444-444444444441'::uuid, owner_id, id, 'pool-1'
from projects where owner_id = '11111111-1111-1111-1111-111111111111' and github_repo_id = 144;
insert into workspaces (id, owner_id, project_id, branch)
select '44444444-4444-4444-4444-444444444442'::uuid, owner_id, id, 'pool-2'
from projects where owner_id = '11111111-1111-1111-1111-111111111111' and github_repo_id = 144;
insert into runtime_computers (owner_id, project_id, status, daytona_sandbox_id, provider, pooled)
select owner_id, id, 'stopped', 'box-pooled', 'daytona', true
from projects where owner_id = '11111111-1111-1111-1111-111111111111' and github_repo_id = 144;

do $$
begin
  begin
    insert into runtime_computers (owner_id, project_id, status, pooled)
    select owner_id, id, 'provisioning', true
    from projects where owner_id = '11111111-1111-1111-1111-111111111111' and github_repo_id = 144;
    raise exception 'FAIL: a project got two pooled boxes';
  exception when unique_violation then
    null;
  end;
end $$;

set role authed;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

do $$
declare
  before_count bigint;
  taken text;
begin
  -- Pooled and stopped: not live, so the plan's count is as it was.
  update runtime_computers set status = 'provisioning' where daytona_sandbox_id = 'box-pooled';
  before_count := live_metered_computers('11111111-1111-1111-1111-111111111111');
  update runtime_computers set status = 'stopped' where daytona_sandbox_id = 'box-pooled';
  if before_count <> live_metered_computers('11111111-1111-1111-1111-111111111111') then
    raise exception 'FAIL: a pooled box counted toward the plan''s cap';
  end if;

  if claim_pooled_computer('44444444-4444-4444-4444-444444444441', 'modal') is not null then
    raise exception 'FAIL: a pooled box went to a session on another provider';
  end if;
  taken := claim_pooled_computer('44444444-4444-4444-4444-444444444441', 'daytona');
  if taken is distinct from 'box-pooled' then
    raise exception 'FAIL: the pooled box was not handed over (got %)', taken;
  end if;
  if not exists (
    select 1 from runtime_computers
    where daytona_sandbox_id = 'box-pooled' and not pooled
      and workspace_id = '44444444-4444-4444-4444-444444444441' and status = 'stopped'
  ) then
    raise exception 'FAIL: the taken box is not the session''s own, stopped';
  end if;
  -- Taken: the next session finds none, and a session with a box keeps it.
  if claim_pooled_computer('44444444-4444-4444-4444-444444444442', 'daytona') is not null then
    raise exception 'FAIL: one pooled box went to two sessions';
  end if;
  begin
    perform claim_pooled_computer('33333333-3333-3333-3333-333333333333', 'daytona');
    raise exception 'FAIL: a pooled box was claimed for another owner''s session';
  exception when others then
    if SQLERRM <> 'workspace not found' then
      raise;
    end if;
  end;
  raise notice 'ok: a pooled box goes to one session of its owner, on its provider, and counts toward no cap';
end $$;

reset role;

-- 22. The CLI's sign-in: no user reaches its codes or tokens, even their own
-- (no grant, and RLS with no policy behind it), and only hashes fit.
do $$
begin
  if has_table_privilege('authenticated', 'cli_tokens', 'select')
     or has_table_privilege('authenticated', 'cli_login_codes', 'select')
     or has_table_privilege('anon', 'cli_tokens', 'select') then
    raise exception 'FAIL: a signed-in user is granted the CLI''s codes or tokens';
  end if;
  insert into cli_tokens (user_id, token_hash, device_name)
  values ('11111111-1111-1111-1111-111111111111', repeat('a', 64), 'Mac');
  begin
    insert into cli_tokens (user_id, token_hash, device_name)
    values ('11111111-1111-1111-1111-111111111111', 'or_cli_not_a_hash', 'Mac');
    raise exception 'FAIL: cli_tokens kept a token that is not a hash';
  exception when check_violation then
    null;
  end;
end $$;

set role authed;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

do $$
begin
  if exists (select 1 from cli_tokens) then
    raise exception 'FAIL: RLS lets a user read their CLI tokens';
  end if;
  begin
    insert into cli_tokens (user_id, token_hash, device_name)
    values ('11111111-1111-1111-1111-111111111111', repeat('b', 64), 'Mac');
    raise exception 'FAIL: a user could give themselves a CLI token';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok: the CLI''s codes and tokens are the server''s alone, and hashed';
end $$;

reset role;

-- 23. Orgs: every user has a personal org they're admin of, a new user's too,
-- and their projects, sessions and boxes are in it.
insert into auth.users (id, email)
values ('33333333-3333-3333-3333-333333333333', 'third@example.com');

do $$
declare n integer;
begin
  select count(*) into n from auth.users u
  where not exists (
    select 1 from organizations o
    join organization_members m on m.org_id = o.id and m.user_id = u.id and m.role = 'admin'
    where o.personal_owner_id = u.id
  );
  if n <> 0 then
    raise exception 'FAIL: % users have no personal org they are admin of', n;
  end if;
  select count(*) into n from projects p
  join organizations o on o.id = p.org_id
  where o.personal_owner_id is distinct from p.owner_id;
  if n <> 0 then
    raise exception 'FAIL: % projects are not in their owner''s personal org', n;
  end if;
  select count(*) into n from workspaces w join projects p on p.id = w.project_id
  where w.org_id <> p.org_id;
  if n <> 0 then
    raise exception 'FAIL: % sessions are not in their project''s org', n;
  end if;
  select count(*) into n from runtime_computers c join projects p on p.id = c.project_id
  where c.org_id <> p.org_id;
  if n <> 0 then
    raise exception 'FAIL: % boxes are not in their project''s org', n;
  end if;
  -- A session names its project's org whatever org it is given.
  insert into workspaces (owner_id, project_id, branch, org_id)
  select '11111111-1111-1111-1111-111111111111', p.id, 'org-forged', o.id
  from projects p, organizations o
  where p.owner_id = '11111111-1111-1111-1111-111111111111'
    and o.personal_owner_id = '22222222-2222-2222-2222-222222222222'
  limit 1;
  if exists (
    select 1 from workspaces w join projects p on p.id = w.project_id
    where w.branch = 'org-forged' and w.org_id <> p.org_id
  ) then
    raise exception 'FAIL: a session took an org other than its project''s';
  end if;
  delete from workspaces where branch = 'org-forged';
  if has_table_privilege('authenticated', 'organizations', 'insert')
     or has_table_privilege('authenticated', 'organization_members', 'insert')
     or has_table_privilege('anon', 'organizations', 'select') then
    raise exception 'FAIL: users may write orgs or memberships, or anon may read them';
  end if;
  raise notice 'ok: every user has a personal org holding their projects, sessions and boxes';
end $$;

-- 24. One project per repository per org: the same repository in two orgs is
-- two projects, and an upsert keyed on (org, repo) given no org finds its
-- owner's personal org. The upsert from before the orgs, on (owner, repo),
-- still works, for the app deployed before the migration.
do $$
declare n integer;
begin
  insert into projects (owner_id, github_repo_id, full_name, owner, name)
  values ('22222222-2222-2222-2222-222222222222', 42, 'immadsahin/runtime', 'immadsahin', 'runtime');
  insert into projects (owner_id, github_repo_id, full_name, owner, name, description)
  values ('22222222-2222-2222-2222-222222222222', 42, 'immadsahin/runtime', 'immadsahin', 'runtime', 'again')
  on conflict (org_id, github_repo_id) do update set description = excluded.description;
  select count(*) into n from projects where github_repo_id = 42;
  if n <> 2 then
    raise exception 'FAIL: expected repo 42 in two orgs, found % projects', n;
  end if;
  if not exists (select 1 from projects where github_repo_id = 42 and description = 'again') then
    raise exception 'FAIL: the (org, repo) upsert did not update the existing project';
  end if;
  insert into projects (owner_id, github_repo_id, full_name, owner, name, description)
  values ('22222222-2222-2222-2222-222222222222', 42, 'immadsahin/runtime', 'immadsahin', 'runtime', 'old app')
  on conflict (owner_id, github_repo_id) do update set description = excluded.description;
  if not exists (select 1 from projects where github_repo_id = 42 and description = 'old app') then
    raise exception 'FAIL: the (owner, repo) upsert from before the orgs did not update the project';
  end if;
  raise notice 'ok: one project per repository per org, and the upsert finds it';
end $$;

-- 25. A team org: its members see its projects and start sessions on them,
-- but each sees only their own sessions; a project is changed by its owner;
-- no one outside reaches any of it; and a removed member loses it at once.
insert into organizations (id, name, created_by)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Team', '11111111-1111-1111-1111-111111111111');
insert into organization_members (org_id, user_id, role)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'admin'),
       ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'member');
-- Another repository: one per user still holds (projects_owner_repo_unique)
-- until team orgs ship.
insert into projects (id, org_id, owner_id, github_repo_id, full_name, owner, name)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '11111111-1111-1111-1111-111111111111', 4242, 'team/app', 'team', 'app');
insert into workspaces (owner_id, project_id, branch)
values ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'admin-session');

-- An outsider can't start a session on the team's project.
do $$
begin
  insert into workspaces (owner_id, project_id, branch)
  values ('33333333-3333-3333-3333-333333333333', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'outsider');
  raise exception 'FAIL: a non-member started a session on an org''s project';
exception when foreign_key_violation then
  raise notice 'ok: a non-member can''t start a session on an org''s project';
end $$;

set role authed;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

do $$
declare n integer;
begin
  if not exists (select 1 from projects where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') then
    raise exception 'FAIL: a member can''t see their org''s project';
  end if;
  if (select count(*) from organizations) <> 2 then
    raise exception 'FAIL: a member should see exactly their two orgs';
  end if;
  if exists (select 1 from organization_members where user_id <> '22222222-2222-2222-2222-222222222222') then
    raise exception 'FAIL: a member can read other people''s memberships';
  end if;
  -- Another member's session stays theirs.
  select count(*) into n from workspaces where project_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  if n <> 0 then
    raise exception 'FAIL: a member sees % of another member''s sessions', n;
  end if;
  -- Their own session on it is theirs.
  insert into workspaces (owner_id, project_id, branch)
  values ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'member-session');
  if not exists (select 1 from workspaces where branch = 'member-session') then
    raise exception 'FAIL: a member can''t see their own session in the org';
  end if;
  -- The project is its owner's to change.
  update projects set description = 'changed' where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'FAIL: a member changed a project they don''t own';
  end if;
  -- And they can't add themselves anywhere.
  begin
    insert into organization_members (org_id, user_id, role)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'admin');
    raise exception 'FAIL: a member made themselves admin';
  exception when insufficient_privilege or unique_violation then
    null;
  end;
  raise notice 'ok: a member sees the org''s projects and only their own sessions';
end $$;

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

do $$
begin
  if exists (select 1 from workspaces where branch = 'member-session') then
    raise exception 'FAIL: an admin sees a member''s session';
  end if;
  if not exists (select 1 from workspaces where branch = 'admin-session') then
    raise exception 'FAIL: the admin can''t see their own session';
  end if;
  raise notice 'ok: an admin doesn''t see members'' sessions';
end $$;

set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';

do $$
begin
  if exists (select 1 from projects where org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
     or exists (select 1 from organizations where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') then
    raise exception 'FAIL: a non-member sees an org or its projects';
  end if;
  raise notice 'ok: a non-member sees nothing of an org';
end $$;

reset role;

delete from organization_members
where org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  and user_id = '22222222-2222-2222-2222-222222222222';

set role authed;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

do $$
begin
  if exists (select 1 from projects where org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
     or exists (select 1 from workspaces where branch = 'member-session') then
    raise exception 'FAIL: a removed member still reaches the org''s projects or their sessions in it';
  end if;
  raise notice 'ok: a removed member loses the org''s projects and their sessions in it at once';
end $$;

reset role;

-- 26. Guards around orgs: a session or box can't be handed to someone outside
-- its org, a project can't move to another org, and a session on a project
-- that isn't there says so.
do $$
begin
  begin
    update workspaces set owner_id = '33333333-3333-3333-3333-333333333333'
    where branch = 'admin-session';
    raise exception 'FAIL: a session was handed to a non-member';
  exception when foreign_key_violation then
    null;
  end;
  begin
    update runtime_computers set owner_id = '33333333-3333-3333-3333-333333333333'
    where id = (select id from runtime_computers limit 1);
    raise exception 'FAIL: a box was handed to a non-member of its org';
  exception when foreign_key_violation then
    null;
  end;
  begin
    update projects set org_id = (
      select id from organizations where personal_owner_id = '11111111-1111-1111-1111-111111111111'
    ) where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    raise exception 'FAIL: a project moved to another org';
  exception when check_violation then
    null;
  end;
  begin
    insert into workspaces (owner_id, project_id, branch)
    values ('11111111-1111-1111-1111-111111111111', gen_random_uuid(), 'no-project');
    raise exception 'FAIL: a session started on a project that isn''t there';
  exception when foreign_key_violation then
    if sqlerrm not like 'project % not found' then
      raise exception 'FAIL: a missing project reads as "%"', sqlerrm;
    end if;
  end;
  raise notice 'ok: sessions and boxes stay with org members, and projects stay in their org';
end $$;
