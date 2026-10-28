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

-- 11. Pull requests are owner-scoped, one per workspace and repository
--     (20261028170000), and name their repository (not null, no default).
insert into pull_requests (
  owner_id, workspace_id, project_id, github_number, url, title, base_branch, head_branch
)
select
  '11111111-1111-1111-1111-111111111111', id, project_id, 7,
  'https://github.com/immadsahin/runtime/pull/7', 'Runtime test', 'main', 'feat/x'
from workspaces where owner_id = '11111111-1111-1111-1111-111111111111' limit 1;

do $$
declare workspace uuid; repo uuid;
begin
  -- The workspace and repository of the pull request just above.
  select workspace_id, project_id into workspace, repo from pull_requests where github_number = 7;
  insert into pull_requests (
    owner_id, workspace_id, project_id, github_number, url, title, base_branch, head_branch
  ) values (
    '11111111-1111-1111-1111-111111111111', workspace, repo, 8,
    'https://github.com/immadsahin/runtime/pull/8', 'Duplicate', 'main', 'feat/x'
  );
  raise exception 'FAIL: a second pull request in the same workspace and repository was allowed';
exception when unique_violation then
  raise notice 'ok: one pull request per workspace and repository enforced';
end $$;

do $$
declare workspace uuid;
begin
  select id into workspace from workspaces where owner_id = '11111111-1111-1111-1111-111111111111' limit 1;
  insert into pull_requests (
    owner_id, workspace_id, github_number, url, title, base_branch, head_branch
  ) values (
    '11111111-1111-1111-1111-111111111111', workspace, 9,
    'https://github.com/immadsahin/runtime/pull/9', 'No repository', 'main', 'feat/x'
  );
  raise exception 'FAIL: a pull request without its repository was allowed';
exception when not_null_violation then
  raise notice 'ok: a pull request names its repository';
end $$;

-- 12. RLS isolates rows by owner.
do $do$
begin
  if not exists (select 1 from pg_roles where rolname = 'authed') then
    create role authed nologin;
  end if;
  grant usage on schema public to authed;
  grant all on all tables in schema public to authed;
  -- What's granted to signed-in users only (check_org_box_cap), as Supabase's
  -- authenticated role has it.
  grant authenticated to authed;
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
declare one uuid; two uuid;
begin
  select id into one from organizations where personal_owner_id = '11111111-1111-1111-1111-111111111111';
  select id into two from organizations where personal_owner_id = '22222222-2222-2222-2222-222222222222';
  insert into billing_customers (org_id, user_id, stripe_customer_id) values (one, '11111111-1111-1111-1111-111111111111', 'cus_1');
  begin
    insert into billing_customers (org_id, user_id, stripe_customer_id) values (two, '22222222-2222-2222-2222-222222222222', 'cus_1');
    raise exception 'FAIL: two orgs shared a Stripe customer';
  exception when unique_violation then
    null;
  end;
  begin
    insert into subscriptions (stripe_subscription_id, org_id, user_id, stripe_customer_id, status, plan,
                               current_period_start, current_period_end, synced_at)
    values ('sub_1', one, '11111111-1111-1111-1111-111111111111', 'cus_1', 'active', 'free', now(), now(), now());
    raise exception 'FAIL: a subscription was stored for a plan Stripe does not sell';
  exception when check_violation then
    null;
  end;
  insert into subscriptions (stripe_subscription_id, org_id, user_id, stripe_customer_id, status, plan,
                             billing_interval, current_period_start, current_period_end, synced_at)
  values ('sub_1', one, '11111111-1111-1111-1111-111111111111', 'cus_1', 'active', 'pro', 'month', now(), now() + interval '1 month', now());
  raise notice 'ok: one Stripe customer per org, and subscriptions are for a sold plan';
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
-- owner's personal org.
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
  -- The org gives Everyone write (as every org starts, 20261028145000), so
  -- a member may change a project they didn't connect.
  update projects set description = 'changed' where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'FAIL: a member with write couldn''t change the org''s project';
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
    where daytona_sandbox_id = 'box-cap-a';
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

-- 27. Team orgs: a user may have the same repository in their personal org
-- and a team org, makes one team org at most, and no one but the server
-- reads or writes the domains orgs claimed.
do $$
begin
  insert into projects (org_id, owner_id, github_repo_id, full_name, owner, name)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111',
          42, 'immadsahin/runtime', 'immadsahin', 'runtime');
  begin
    insert into organizations (name, created_by)
    values ('Second team', '11111111-1111-1111-1111-111111111111');
    raise exception 'FAIL: a user made a second team org';
  exception when unique_violation then
    null;
  end;
  insert into organization_domains (domain, org_id, claimed_by)
  values ('example.com', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111');
  begin
    insert into organization_domains (domain, org_id)
    values ('example.com', (select id from organizations where personal_owner_id = '22222222-2222-2222-2222-222222222222'));
    raise exception 'FAIL: two orgs claimed one domain';
  exception when unique_violation then
    null;
  end;
  begin
    insert into organization_domains (domain, org_id) values ('Example.COM', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    raise exception 'FAIL: a domain was kept in capitals';
  exception when check_violation then
    null;
  end;
  if has_table_privilege('authenticated', 'organization_domains', 'select')
     or has_table_privilege('anon', 'organization_domains', 'select') then
    raise exception 'FAIL: users may read the domains orgs claimed';
  end if;
  raise notice 'ok: a repository in a personal and a team org, one team org per user, one org per domain';
end $$;

-- 28. A warm pool per member: two members of an org each keep a pooled box
-- for the same project, and each sees only their own.
insert into organization_members (org_id, user_id, role)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'member')
on conflict do nothing;
insert into runtime_computers (owner_id, project_id, pooled, status)
values ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', true, 'stopped'),
       ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', true, 'stopped');

do $$
begin
  insert into runtime_computers (owner_id, project_id, pooled, status)
  values ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', true, 'stopped');
  raise exception 'FAIL: a member kept two pooled boxes for one project';
exception when unique_violation then
  raise notice 'ok: one pooled box per member per project';
end $$;

set role authed;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

do $$
begin
  if (select count(*) from runtime_computers
      where project_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' and pooled) <> 1
     or exists (select 1 from runtime_computers where owner_id <> '22222222-2222-2222-2222-222222222222') then
    raise exception 'FAIL: a member sees a pooled box that isn''t theirs';
  end if;
  raise notice 'ok: a member sees only their own pooled box';
end $$;

reset role;

-- 29. Making a team org is the server's: its creator is its admin, its
-- domain is claimed with it, and a taken domain leaves nothing behind.
do $$
declare org uuid;
begin
  if has_function_privilege('authenticated', 'create_team_org(text, uuid, text)', 'execute')
     or has_function_privilege('anon', 'create_team_org(text, uuid, text)', 'execute') then
    raise exception 'FAIL: a user may make team orgs directly';
  end if;
  org := create_team_org('Third team', '33333333-3333-3333-3333-333333333333', 'third.example');
  if not exists (select 1 from organization_members
                 where org_id = org and user_id = '33333333-3333-3333-3333-333333333333' and role = 'admin')
     or not exists (select 1 from organization_domains where domain = 'third.example' and org_id = org) then
    raise exception 'FAIL: a team org was made without its admin or its domain';
  end if;
  begin
    perform create_team_org('Fourth team', '22222222-2222-2222-2222-222222222222', 'third.example');
    raise exception 'FAIL: a second org claimed a domain';
  exception when unique_violation then
    null;
  end;
  if exists (select 1 from organizations where name = 'Fourth team') then
    raise exception 'FAIL: a failed team org left its org behind';
  end if;
  raise notice 'ok: a team org is made with its admin and domain, or not at all';
end $$;

-- 30. Members: an invite is accepted once, by its token, while it's open;
-- inviting again while one is open is refused; a request is approved once.
-- No user reaches any of it but the server.
do $$
declare
  team uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  org uuid;
begin
  if has_table_privilege('authenticated', 'organization_invites', 'select')
     or has_table_privilege('authenticated', 'organization_join_requests', 'select')
     or has_table_privilege('authenticated', 'organization_removals', 'select')
     or has_function_privilege('authenticated', 'accept_org_invite(text, uuid)', 'execute')
     or has_function_privilege('authenticated', 'remove_org_member(uuid, uuid, uuid)', 'execute') then
    raise exception 'FAIL: a user may reach invites, requests, removals or the member functions';
  end if;

  insert into organization_invites (org_id, email, role, token_hash, expires_at)
  values (team, 'third@example.com', 'member', repeat('c', 64), now() + interval '7 days');
  begin
    insert into organization_invites (org_id, email, role, token_hash, expires_at)
    values (team, 'third@example.com', 'admin', repeat('d', 64), now() + interval '7 days');
    raise exception 'FAIL: two open invites for one email';
  exception when unique_violation then
    null;
  end;
  begin
    insert into organization_invites (org_id, email, role, token_hash, expires_at)
    values (team, 'Third@Example.com', 'member', repeat('e', 64), now() + interval '7 days');
    raise exception 'FAIL: an invite kept an email in capitals';
  exception when check_violation then
    null;
  end;

  org := accept_org_invite(repeat('c', 64), '33333333-3333-3333-3333-333333333333');
  if org <> team or not exists (
    select 1 from organization_members
    where org_id = team and user_id = '33333333-3333-3333-3333-333333333333' and role = 'member'
  ) then
    raise exception 'FAIL: an accepted invite made no member';
  end if;
  begin
    perform accept_org_invite(repeat('c', 64), '22222222-2222-2222-2222-222222222222');
    raise exception 'FAIL: an invite was accepted twice';
  exception when raise_exception then
    if sqlerrm <> 'invite_invalid' then raise; end if;
  end;

  insert into organization_invites (org_id, email, role, token_hash, expires_at)
  values (team, 'late@example.com', 'member', repeat('f', 64), now() - interval '1 minute');
  begin
    perform accept_org_invite(repeat('f', 64), '22222222-2222-2222-2222-222222222222');
    raise exception 'FAIL: an expired invite was accepted';
  exception when raise_exception then
    if sqlerrm <> 'invite_invalid' then raise; end if;
  end;

  -- A request to join, approved once.
  delete from organization_members where org_id = team and user_id = '22222222-2222-2222-2222-222222222222';
  insert into organization_join_requests (id, org_id, user_id, email)
  values ('dddddddd-dddd-dddd-dddd-dddddddddddd', team, '22222222-2222-2222-2222-222222222222', 'other@example.com');
  begin
    insert into organization_join_requests (org_id, user_id, email)
    values (team, '22222222-2222-2222-2222-222222222222', 'other@example.com');
    raise exception 'FAIL: two pending requests from one user to one org';
  exception when unique_violation then
    null;
  end;
  perform approve_join_request('dddddddd-dddd-dddd-dddd-dddddddddddd', '11111111-1111-1111-1111-111111111111', 'member');
  if not exists (select 1 from organization_members where org_id = team and user_id = '22222222-2222-2222-2222-222222222222') then
    raise exception 'FAIL: an approved request made no member';
  end if;
  begin
    perform approve_join_request('dddddddd-dddd-dddd-dddd-dddddddddddd', '11111111-1111-1111-1111-111111111111', 'admin');
    raise exception 'FAIL: a request was approved twice';
  exception when raise_exception then
    if sqlerrm <> 'request_not_pending' then raise; end if;
  end;
  raise notice 'ok: invites and requests let a member in once, and only the server reaches them';
end $$;

-- 31. Removal: never the last admin, never out of a personal org; a removed
-- member is recorded with the time, and coming back clears it.
do $$
declare team uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
begin
  begin
    perform remove_org_member(team, '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111');
    raise exception 'FAIL: the last admin left their org';
  exception when raise_exception then
    if sqlerrm <> 'last_admin' then raise; end if;
  end;
  begin
    perform set_org_member_role(team, '11111111-1111-1111-1111-111111111111', 'member');
    raise exception 'FAIL: the last admin was made a member';
  exception when raise_exception then
    if sqlerrm <> 'last_admin' then raise; end if;
  end;
  begin
    perform remove_org_member(
      (select id from organizations where personal_owner_id = '11111111-1111-1111-1111-111111111111'),
      '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111');
    raise exception 'FAIL: someone was taken out of a personal org';
  exception when raise_exception then
    if sqlerrm <> 'personal_org' then raise; end if;
  end;

  -- With a second admin, the first may go.
  perform set_org_member_role(team, '33333333-3333-3333-3333-333333333333', 'admin');
  perform set_org_member_role(team, '11111111-1111-1111-1111-111111111111', 'member');
  perform set_org_member_role(team, '11111111-1111-1111-1111-111111111111', 'admin');

  perform remove_org_member(team, '22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111');
  if exists (select 1 from organization_members where org_id = team and user_id = '22222222-2222-2222-2222-222222222222')
     or not exists (select 1 from organization_removals where org_id = team and user_id = '22222222-2222-2222-2222-222222222222') then
    raise exception 'FAIL: a removed member is still in, or not recorded as removed';
  end if;
  begin
    perform remove_org_member(team, '22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111');
    raise exception 'FAIL: a non-member was removed';
  exception when raise_exception then
    if sqlerrm <> 'not_a_member' then raise; end if;
  end;

  perform add_org_member(team, '22222222-2222-2222-2222-222222222222', 'member');
  if exists (select 1 from organization_removals where org_id = team and user_id = '22222222-2222-2222-2222-222222222222') then
    raise exception 'FAIL: coming back left the removal, and its clock, running';
  end if;
  raise notice 'ok: an org keeps an admin, a personal org its owner, and a removal is recorded until they return';
end $$;

-- 32. A project (environments) is its org's: one default per repository,
-- which any member makes and every member's session starts from; its
-- repositories are in its org; and a session's project is in the session's.
do $$
declare
  team uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  shared uuid;
  personal_env uuid;
  personal_project uuid;
begin
  -- Made by a member who isn't the repository's owner: in the team org.
  insert into environments (owner_id, name, default_for_project_id)
  values ('22222222-2222-2222-2222-222222222222', 'app', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
  returning id into shared;
  if (select org_id from environments where id = shared) <> team then
    raise exception 'FAIL: a repository''s default project isn''t in the repository''s org';
  end if;
  insert into environment_repos (owner_id, environment_id, project_id, checkout_name)
  values ('22222222-2222-2222-2222-222222222222', shared, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'app');
  if (select org_id from environment_repos where environment_id = shared) <> team then
    raise exception 'FAIL: a project''s repository took another org';
  end if;

  begin
    insert into environments (owner_id, name, default_for_project_id)
    values ('11111111-1111-1111-1111-111111111111', 'app again', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    raise exception 'FAIL: a repository got a second default project';
  exception when unique_violation then
    null;
  end;

  -- A repository of another org can't be one of the project's.
  select id into personal_project from projects
  where owner_id = '22222222-2222-2222-2222-222222222222' and org_id <> team limit 1;
  begin
    insert into environment_repos (owner_id, environment_id, project_id, checkout_name)
    values ('22222222-2222-2222-2222-222222222222', shared, personal_project, 'other');
    raise exception 'FAIL: a project took a repository from another org';
  exception when foreign_key_violation then
    null;
  end;

  -- The admin's session starts from the project the member made.
  insert into workspaces (owner_id, project_id, branch, environment_id)
  values ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'from-shared', shared);

  -- But not from a project of another org.
  insert into environments (owner_id, name) values ('11111111-1111-1111-1111-111111111111', 'mine')
  returning id into personal_env;
  if (select org_id from environments where id = personal_env) =  team then
    raise exception 'FAIL: a project made with no repository went to a team org';
  end if;
  begin
    insert into workspaces (owner_id, project_id, branch, environment_id)
    values ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'from-personal', personal_env);
    raise exception 'FAIL: a session started from another org''s project';
  exception when foreign_key_violation then
    null;
  end;
  raise notice 'ok: a project is its org''s, one default per repository, shared by its members';
end $$;

-- 33. Access: every org starts with Everyone write; an admin can narrow it to
-- read, or to nothing, and give a role write on one project; a member gets
-- the highest any grant gives them; admins have write always. What a member
-- can't read, they can't see or start a session on.
do $$
declare
  team uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  app uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  builders uuid;
begin
  if not exists (select 1 from access_grants where org_id = team and role_id is null and project_id is null and level = 'write') then
    raise exception 'FAIL: a new org didn''t start with Everyone: write';
  end if;
  if has_table_privilege('authenticated', 'access_grants', 'select')
     or has_table_privilege('authenticated', 'member_roles', 'select')
     or has_table_privilege('authenticated', 'organization_roles', 'select')
     or has_function_privilege('authenticated', 'project_level(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'environment_level(uuid, uuid)', 'execute') then
    raise exception 'FAIL: a user may read grants or roles, or ask about someone else''s access';
  end if;

  update access_grants set level = 'read' where org_id = team and role_id is null and project_id is null;
  if project_level('22222222-2222-2222-2222-222222222222', app) <> 'read' then
    raise exception 'FAIL: Everyone: read didn''t give a member read';
  end if;
  if project_level('11111111-1111-1111-1111-111111111111', app) <> 'write' then
    raise exception 'FAIL: an admin lost write';
  end if;
  if project_level('33333333-3333-3333-3333-333333333333', app) <> 'write'
     and not exists (select 1 from organization_members where org_id = team and user_id = '33333333-3333-3333-3333-333333333333' and role = 'admin') then
    raise exception 'FAIL: unexpected level for the third user';
  end if;

  insert into organization_roles (org_id, name) values (team, 'Builders') returning id into builders;
  insert into access_grants (org_id, role_id, project_id, level) values (team, builders, app, 'write');
  insert into member_roles (org_id, user_id, role_id) values (team, '22222222-2222-2222-2222-222222222222', builders);
  if project_level('22222222-2222-2222-2222-222222222222', app) <> 'write' then
    raise exception 'FAIL: a role''s write on one project didn''t reach its member';
  end if;
  if environment_level('22222222-2222-2222-2222-222222222222',
       (select id from environments where default_for_project_id = app)) <> 'write' then
    raise exception 'FAIL: a project''s settings didn''t follow its repository''s level';
  end if;
  begin
    insert into access_grants (org_id, role_id, project_id, level) values (team, builders, app, 'read');
    raise exception 'FAIL: two grants to one role on one project';
  exception when unique_violation then
    null;
  end;
  raise notice 'ok: grants to Everyone and to roles, on all projects and on one, give the highest; admins write';
end $$;

-- As the member: read on everything, write on the app project through the
-- role, so they change it, but can't connect a new project.
set role authed;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

do $$
declare n integer;
begin
  update projects set description = 'builders' where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'FAIL: a role''s write didn''t let its member change the project';
  end if;
  update projects set description = 'not mine' where org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and id <> 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'FAIL: read let a member change % projects', n;
  end if;
  begin
    insert into projects (org_id, owner_id, github_repo_id, full_name, owner, name)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 777, 'team/new', 'team', 'new');
    raise exception 'FAIL: a member without write on all projects connected one';
  exception when insufficient_privilege then
    null;
  end;
  if my_project_level('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') <> 'write' then
    raise exception 'FAIL: my_project_level didn''t answer for the signed-in user';
  end if;
  raise notice 'ok: a member changes what they may write, and only that';
end $$;

reset role;

-- Nothing for Everyone, and the role gone: the member sees none of the org's
-- projects and can't start a session on one; their own sessions stay theirs.
delete from access_grants where org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and role_id is null and project_id is null;
delete from member_roles where user_id = '22222222-2222-2222-2222-222222222222';

set role authed;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

do $$
begin
  if exists (select 1 from projects where org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') then
    raise exception 'FAIL: a member with no grant sees the org''s projects';
  end if;
  begin
    insert into workspaces (owner_id, project_id, branch)
    values ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'no-access');
    raise exception 'FAIL: a member started a session on a project they can''t read';
  exception when foreign_key_violation then
    null;
  end;
  if not exists (select 1 from workspaces where branch = 'member-session') then
    raise exception 'FAIL: losing read took a member''s own session away';
  end if;
  raise notice 'ok: no grant, no project, and no new session on it; their sessions stay theirs';
end $$;

reset role;

-- 34. A repository's default project and its repository are made together,
-- and asking again finds the one there.
do $$
declare first uuid; again uuid; app2 uuid;
begin
  select id into app2 from projects
  where org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and github_repo_id = 42;
  first := make_default_environment(app2, '11111111-1111-1111-1111-111111111111', 'runtime');
  again := make_default_environment(app2, '22222222-2222-2222-2222-222222222222', 'runtime');
  if first is distinct from again
     or (select count(*) from environment_repos where environment_id = first) <> 1 then
    raise exception 'FAIL: a default project was made twice, or without its repository';
  end if;
  if has_function_privilege('authenticated', 'make_default_environment(uuid, uuid, text)', 'execute') then
    raise exception 'FAIL: a user may make default projects directly';
  end if;
  raise notice 'ok: a default project and its repository are made together, once';
end $$;

-- 35. Changing access is one step: a grant set or taken in place, a failed
-- one leaving what was there; a member's roles all or none; never an admin's;
-- an admin made holds none.
do $$
declare
  team uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  builders uuid := (select id from organization_roles where org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and name = 'Builders');
  other_role uuid;
begin
  perform set_grant(team, null, null, 'write');
  perform set_grant(team, null, null, 'read');
  if (select count(*) from access_grants where org_id = team and role_id is null and project_id is null) <> 1
     or (select level from access_grants where org_id = team and role_id is null and project_id is null) <> 'read' then
    raise exception 'FAIL: set_grant didn''t change Everyone''s grant in place';
  end if;
  -- A project of another org: refused, and Everyone keeps read.
  begin
    perform set_grant(team, null, (select id from projects where org_id <> team limit 1), 'write');
    raise exception 'FAIL: a grant on another org''s project';
  exception when foreign_key_violation then
    null;
  end;
  if (select level from access_grants where org_id = team and role_id is null and project_id is null) <> 'read' then
    raise exception 'FAIL: a refused grant changed Everyone''s';
  end if;
  perform set_grant(team, null, null, null);
  if exists (select 1 from access_grants where org_id = team and role_id is null and project_id is null) then
    raise exception 'FAIL: set_grant(null) left the grant';
  end if;
  perform set_grant(team, null, null, 'write');

  perform set_member_roles(team, '22222222-2222-2222-2222-222222222222', array[builders]);
  insert into organization_roles (org_id, name)
  values ((select id from organizations where personal_owner_id = '22222222-2222-2222-2222-222222222222'), 'Elsewhere')
  returning id into other_role;
  begin
    perform set_member_roles(team, '22222222-2222-2222-2222-222222222222', array[other_role]);
    raise exception 'FAIL: a member got another org''s role';
  exception when foreign_key_violation then
    null;
  end;
  if not exists (select 1 from member_roles where org_id = team and user_id = '22222222-2222-2222-2222-222222222222' and role_id = builders) then
    raise exception 'FAIL: a refused change took a member''s roles away';
  end if;
  begin
    perform set_member_roles(team, '11111111-1111-1111-1111-111111111111', array[builders]);
    raise exception 'FAIL: an admin was given a role';
  exception when raise_exception then
    if sqlerrm <> 'admin_roles' then raise; end if;
  end;
  perform set_org_member_role(team, '22222222-2222-2222-2222-222222222222', 'admin');
  if exists (select 1 from member_roles where org_id = team and user_id = '22222222-2222-2222-2222-222222222222') then
    raise exception 'FAIL: a member made admin kept their roles';
  end if;
  perform set_org_member_role(team, '22222222-2222-2222-2222-222222222222', 'member');
  if has_function_privilege('authenticated', 'set_grant(uuid, uuid, uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'set_member_roles(uuid, uuid, uuid[])', 'execute') then
    raise exception 'FAIL: a user may change grants or roles directly';
  end if;
  raise notice 'ok: grants and roles change in one step, and a refused change keeps what was there';
end $$;

-- 36. The GitHub App's installations: one org each, the server's alone, and
-- gone with their org.
do $$
declare personal uuid := (select id from organizations where personal_owner_id = '33333333-3333-3333-3333-333333333333');
begin
  if has_table_privilege('authenticated', 'github_installations', 'select')
     or has_table_privilege('anon', 'github_installations', 'select') then
    raise exception 'FAIL: users may read the App''s installations';
  end if;
  insert into github_installations (installation_id, org_id, account_login, account_type, repository_selection)
  values (12345, personal, 'third', 'User', 'all');
  begin
    insert into github_installations (installation_id, org_id, account_login, account_type, repository_selection)
    values (12345, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'third', 'User', 'all');
    raise exception 'FAIL: one installation kept by two orgs';
  exception when unique_violation then
    null;
  end;
  begin
    insert into github_installations (installation_id, org_id, account_login, account_type, repository_selection)
    values (999, personal, 'x', 'Enterprise', 'all');
    raise exception 'FAIL: an installation on an account GitHub has no such type of';
  exception when check_violation then
    null;
  end;
  raise notice 'ok: an installation is one org''s, and only the server reaches it';
end $$;

-- 37. An installation GitHub told of but no org has claimed keeps who
-- installed it; one with neither isn't kept.
do $$
begin
  insert into github_installations (installation_id, account_login, account_type, repository_selection, installer_id, installer_login)
  values (777, 'acme', 'Organization', 'all', 4242, 'acme-owner');
  begin
    insert into github_installations (installation_id, account_login, account_type, repository_selection, installer_login)
    values (778, 'acme', 'Organization', 'all', 'only-a-login');
    raise exception 'FAIL: an unclaimed installation with no installer to claim it';
  exception when check_violation then
    null;
  end;
  raise notice 'ok: an unclaimed installation keeps its installer';
end $$;

-- 38. An installation an org removed remembers which, gone with that org.
do $$
begin
  update github_installations set removed_from = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' where installation_id = 777;
  if (select removed_from from github_installations where installation_id = 777) <> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' then
    raise exception 'FAIL: removed_from not kept';
  end if;
  raise notice 'ok: an installation remembers the org that removed it';
end $$;

-- 39. Deleting the org that removed an installation deletes it with the org,
-- rather than clearing the mark that keeps it from other orgs.
do $$
declare doomed uuid;
begin
  insert into organizations (name, created_by) values ('Doomed', null) returning id into doomed;
  update github_installations set removed_from = doomed where installation_id = 777;
  delete from organizations where id = doomed;
  if exists (select 1 from github_installations where installation_id = 777) then
    raise exception 'FAIL: an installation outlived the org that removed it, claimable by any org';
  end if;
  raise notice 'ok: an installation goes with the org that removed it';
end $$;

-- 40. A user's GitHub identity is their own sign-in until they choose the App,
-- and nothing else.
do $$
declare someone constant uuid := '11111111-1111-1111-1111-111111111111';
begin
  insert into user_credentials (user_id) values (someone) on conflict (user_id) do nothing;
  if (select github_identity from user_credentials where user_id = someone) <> 'personal' then
    raise exception 'FAIL: a user is not on their own GitHub sign-in at first';
  end if;
  update user_credentials set github_identity = 'app' where user_id = someone;
  begin
    update user_credentials set github_identity = 'bot' where user_id = someone;
    raise exception 'FAIL: an unknown GitHub identity was kept';
  exception when check_violation then
    null;
  end;
  update user_credentials set github_identity = 'personal' where user_id = someone;
  raise notice 'ok: a GitHub identity is personal or app, personal at first';
end $$;

-- 41. A claim answers once: a session that takes a ready box (stopped, now
-- its own) gets one row to provision it, as does a stopped project box
-- (20261030110000; the rewrites lost 20260805150000's `return`).
do $$
declare someone constant uuid := '11111111-1111-1111-1111-111111111111';
declare project uuid; session uuid; rows integer;
begin
  perform set_config('request.jwt.claim.sub', someone::text, true);
  select id into project from projects where owner_id = someone limit 1;
  insert into workspaces (owner_id, project_id, branch, base_branch, provider, status)
    values (someone, project, 'claims-answer-once', 'main', 'daytona', 'creating') returning id into session;
  insert into runtime_computers (owner_id, project_id, agent_secret, status, pooled, pool_slot, daytona_sandbox_id, provider)
    values (someone, project, 's', 'stopped', true, 1, 'box-once', 'daytona');
  if claim_pooled_computer(session, 'daytona') is distinct from 'box-once' then
    raise exception 'FAIL: the ready box was not handed to the session';
  end if;
  select count(*) into rows from claim_workspace_computer(session, 'secret', 'v1', null);
  if rows <> 1 then
    raise exception 'FAIL: claiming a session''s stopped box answered % rows, want 1', rows;
  end if;
  -- The project's shared box from before (one a project), stopped.
  if not exists (select 1 from runtime_computers where project_id = project and workspace_id is null and not pooled) then
    insert into runtime_computers (owner_id, project_id, agent_secret, status, daytona_sandbox_id)
      values (someone, project, 's', 'stopped', 'box-project-once');
  end if;
  update runtime_computers set status = 'stopped'
    where project_id = project and workspace_id is null and not pooled;
  select count(*) into rows from claim_runtime_computer(project, 'secret', 'v1', null);
  if rows <> 1 then
    raise exception 'FAIL: claiming a project''s stopped box answered % rows, want 1', rows;
  end if;
  raise notice 'ok: a claim of a stopped box answers once';
end $$;

-- 42. A team org keeps provider keys for its members; a personal org has none
-- of its own, and the keys go with the org.
do $$
declare personal uuid;
begin
  insert into org_provider_keys (org_id, provider, key_ciphertext, key_hint)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'openrouter', 'v1.sealed', 'abcd');
  select id into personal from organizations where personal_owner_id = '11111111-1111-1111-1111-111111111111';
  begin
    insert into org_provider_keys (org_id, provider, key_ciphertext) values (personal, 'openrouter', 'v1.sealed');
    raise exception 'FAIL: a personal org kept a key of its own';
  exception when check_violation then
    null;
  end;
  if has_table_privilege('authenticated', 'org_provider_keys', 'select') then
    raise exception 'FAIL: members can read the org''s keys directly';
  end if;
  delete from org_provider_keys where org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  raise notice 'ok: a team org keeps provider keys, a personal org none';
end $$;

-- 43. A team org keeps defaults for its members; a personal org none of its
-- own. A user's box size is theirs only once they chose it.
do $$
declare personal uuid;
begin
  insert into organization_settings (org_id, default_model, box_size)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"provider":"outrunner","id":"glm"}', 'medium');
  begin
    update organization_settings set box_size = 'huge' where org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    raise exception 'FAIL: an unknown box size was kept';
  exception when check_violation then
    null;
  end;
  select id into personal from organizations where personal_owner_id = '11111111-1111-1111-1111-111111111111';
  begin
    insert into organization_settings (org_id, box_size) values (personal, 'small');
    raise exception 'FAIL: a personal org kept defaults of its own';
  exception when check_violation then
    null;
  end;
  insert into user_credentials (user_id) values ('11111111-1111-1111-1111-111111111111') on conflict (user_id) do nothing;
  if (select box_size_chosen from user_credentials where user_id = '11111111-1111-1111-1111-111111111111') then
    raise exception 'FAIL: a box size no one chose counts as chosen';
  end if;
  delete from organization_settings where org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  raise notice 'ok: a team org keeps defaults, a personal org none';
end $$;

-- 44. Billing is the org's: its cap counts every member's boxes, and only
-- its members check it; a subscription and a customer belong to an org.
insert into runtime_computers (owner_id, project_id, agent_secret, image_version, status, daytona_sandbox_id)
values ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 's-org-cap', 'v1', 'ready', 'box-org-cap');

set role authed;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$
begin
  -- A member's own box count is 0 here, but the org runs one: its cap of 1
  -- is reached.
  begin
    perform check_org_box_cap('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1);
    raise exception 'FAIL: the org cap left out another member''s box';
  exception when others then
    if SQLSTATE <> 'P4BX1' then raise; end if;
  end;
  perform check_org_box_cap('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 2);
  begin
    perform check_org_box_cap((select id from organizations where personal_owner_id = '22222222-2222-2222-2222-222222222222'), 5);
    raise exception 'FAIL: a user checked another org''s cap';
  exception when others then
    if SQLERRM <> 'org not found' then raise; end if;
  end;
  begin
    perform live_org_computers('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    raise exception 'FAIL: a user counted the org''s boxes directly';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok: an org''s box cap counts every member''s boxes, for its members';
end $$;
reset role;

do $$
declare buyer constant uuid := '33333333-3333-3333-3333-333333333399';
begin
  if exists (select 1 from subscriptions where org_id is null) or exists (select 1 from billing_customers where org_id is null) then
    raise exception 'FAIL: billing left without an org';
  end if;
  -- The admin who bought a team org's plan leaving keeps the org's plan.
  insert into auth.users (id) values (buyer);
  insert into billing_customers (org_id, user_id, stripe_customer_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', buyer, 'cus_team');
  insert into subscriptions (stripe_subscription_id, org_id, user_id, stripe_customer_id, status, plan,
                             billing_interval, current_period_start, current_period_end, synced_at)
  values ('sub_team', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', buyer, 'cus_team', 'active', 'pro', 'month', now(), now() + interval '1 month', now());
  delete from auth.users where id = buyer;
  if not exists (select 1 from subscriptions where stripe_subscription_id = 'sub_team' and user_id is null)
     or not exists (select 1 from billing_customers where stripe_customer_id = 'cus_team' and user_id is null) then
    raise exception 'FAIL: the buyer leaving took the org''s plan with them';
  end if;
  delete from subscriptions where stripe_subscription_id = 'sub_team';
  delete from billing_customers where stripe_customer_id = 'cus_team';
  delete from runtime_computers where daytona_sandbox_id = 'box-org-cap';
  raise notice 'ok: subscriptions and customers are an org''s';
end $$;

-- 45. An org's connector runs on its own plan: its boxes take no room in the
-- org's, and its cap counts only its own.
insert into auth.users (id) values ('44444444-4444-4444-4444-444444444444');
insert into organization_members (org_id, user_id, role)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44444444-4444-4444-4444-444444444444', 'admin');
insert into org_connectors (org_id, user_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44444444-4444-4444-4444-444444444444');
insert into runtime_computers (owner_id, project_id, agent_secret, image_version, status, daytona_sandbox_id)
values ('44444444-4444-4444-4444-444444444444', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 's-conn', 'v1', 'ready', 'box-conn');

set role authed;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$
begin
  -- A member: the connector's running box doesn't count.
  perform check_org_box_cap('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1);
  raise notice 'ok: a member''s cap leaves out the connector''s boxes';
end $$;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
do $$
begin
  begin
    perform check_org_box_cap('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1);
    raise exception 'FAIL: the connector''s cap left out its own box';
  exception when others then
    if SQLSTATE <> 'P4BX1' then raise; end if;
  end;
  perform check_org_box_cap('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 2);
  raise notice 'ok: the connector''s cap counts its own boxes';
end $$;
reset role;
delete from runtime_computers where daytona_sandbox_id = 'box-conn';

-- 46. A team org's allowance on Outrunner's models is the server's alone, and
-- goes with the org.
do $$
begin
  if has_table_privilege('authenticated', 'org_model_allowance', 'select') then
    raise exception 'FAIL: members can read the org''s model key';
  end if;
  insert into organizations (id, name, created_by) values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Gone', null);
  insert into org_model_allowance (org_id, key_hash) values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'h');
  delete from organizations where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  if exists (select 1 from org_model_allowance where org_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd') then
    raise exception 'FAIL: an org''s model key outlived it';
  end if;
  raise notice 'ok: an org''s model allowance is the server''s, gone with the org';
end $$;

-- 47. A session's first prompt is claimed once per idempotency key
-- (claimFirstPrompt): a second claim, the same key's or another's, finds it
-- held; released, the key claims it again; a claim abandoned mid-send is
-- taken over by its own key, never by another, and never once sent; the
-- request it was taken from can't release it (matched on claimed_at). The
-- key is kept short.
do $$
declare
  ws uuid;
  n int;
begin
  select id into ws from workspaces where owner_id = '11111111-1111-1111-1111-111111111111' limit 1;
  update workspaces set first_prompt_key = 'k1', first_prompt_claimed_at = now()
  where id = ws and first_prompt_key is null;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: a session''s first prompt could not be claimed'; end if;
  update workspaces set first_prompt_key = 'k2' where id = ws and first_prompt_key is null;
  get diagnostics n = row_count;
  if n <> 0 or (select first_prompt_key from workspaces where id = ws) <> 'k1' then
    raise exception 'FAIL: a session''s first prompt was claimed twice';
  end if;
  update workspaces set first_prompt_key = null, first_prompt_claimed_at = null
  where id = ws and first_prompt_key = 'k1' and first_prompt_sent_at is null;
  update workspaces set first_prompt_key = 'k1', first_prompt_claimed_at = now() - interval '10 minutes'
  where id = ws and first_prompt_key is null;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: a released first prompt could not be claimed again'; end if;
  update workspaces set first_prompt_claimed_at = now()
  where id = ws and first_prompt_key = 'k1' and first_prompt_sent_at is null
    and first_prompt_claimed_at < now() - interval '2 minutes';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: an abandoned first-prompt claim could not be taken over'; end if;
  update workspaces set first_prompt_key = null, first_prompt_claimed_at = null
  where id = ws and first_prompt_key = 'k1' and first_prompt_sent_at is null
    and first_prompt_claimed_at = now() - interval '10 minutes';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: a taken-over first-prompt claim was released by its old request'; end if;
  update workspaces set first_prompt_sent_at = now() where id = ws and first_prompt_key = 'k1';
  update workspaces set first_prompt_key = null, first_prompt_claimed_at = null
  where id = ws and first_prompt_key = 'k1' and first_prompt_sent_at is null;
  if (select first_prompt_key from workspaces where id = ws) is distinct from 'k1' then
    raise exception 'FAIL: a sent first prompt was released';
  end if;
  begin
    update workspaces set first_prompt_key = repeat('x', 101) where id = ws;
    raise exception 'FAIL: an overlong first-prompt key was kept';
  exception when check_violation then
    null;
  end;
  update workspaces set first_prompt_key = null, first_prompt_claimed_at = null, first_prompt_sent_at = null
  where id = ws;
  raise notice 'ok: a session''s first prompt is claimed once per key';
end $$;

-- 47. An org's usage controls: a limit between 10% and all of the plan's hours,
-- alerts at 50, 80 or 100%, and each alert once per period.
do $$
begin
  insert into organization_settings (org_id, usage_limit_percent, alert_thresholds)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 80, '{50,100}')
  on conflict (org_id) do update set usage_limit_percent = 80, alert_thresholds = '{50,100}';
  begin
    update organization_settings set usage_limit_percent = 150 where org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    raise exception 'FAIL: a limit beyond the plan was kept';
  exception when check_violation then null;
  end;
  begin
    update organization_settings set alert_thresholds = '{70}' where org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    raise exception 'FAIL: an alert at an unknown share was kept';
  exception when check_violation then null;
  end;
  insert into org_usage_alerts (org_id, period_start, threshold) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-11-01', 80);
  begin
    insert into org_usage_alerts (org_id, period_start, threshold) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-11-01', 80);
    raise exception 'FAIL: an alert was recorded twice';
  exception when unique_violation then null;
  end;
  if has_table_privilege('authenticated', 'org_usage_alerts', 'select') then
    raise exception 'FAIL: members can read the org''s alerts directly';
  end if;
  delete from org_usage_alerts where org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  delete from organization_settings where org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  raise notice 'ok: an org''s usage controls stay within its plan, and alert once';
end $$;

-- 48. The audit log is append-only and the server's alone; its events go only
-- with their org.
do $$
declare event bigint;
begin
  insert into audit_events (org_id, actor_type, actor_id, actor_label, action, resource_type, resource_label)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'user', '11111111-1111-1111-1111-111111111111', 'owner', 'member.invited', 'invite', 'new@example.com')
  returning id into event;
  begin
    update audit_events set action = 'member.removed' where id = event;
    raise exception 'FAIL: an audit event was changed';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into audit_events (org_id, actor_type, actor_label, action) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'user', 'x', 'Not An Action');
    raise exception 'FAIL: an action outside the naming was kept';
  exception when check_violation then null;
  end;
  if has_table_privilege('authenticated', 'audit_events', 'select') or has_table_privilege('authenticated', 'audit_events', 'insert') then
    raise exception 'FAIL: members can reach the audit log directly';
  end if;
  insert into organizations (id, name, created_by) values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Short-lived', null);
  insert into audit_events (org_id, actor_type, actor_label, action) values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'system', 'Outrunner', 'org.renamed');
  delete from organizations where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  if exists (select 1 from audit_events where org_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') then
    raise exception 'FAIL: an org''s events outlived it';
  end if;
  -- Someone who acted going doesn't touch (or refuse) the record of it.
  insert into auth.users (id) values ('55555555-5555-5555-5555-555555555555');
  insert into audit_events (org_id, actor_type, actor_id, actor_label, action)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'user', '55555555-5555-5555-5555-555555555555', 'leaver', 'member.left');
  delete from auth.users where id = '55555555-5555-5555-5555-555555555555';
  if not exists (select 1 from audit_events where actor_label = 'leaver') then
    raise exception 'FAIL: an actor going took their events';
  end if;
  raise notice 'ok: the audit log is append-only, the server''s, and goes with its org';
end $$;

-- 49. The GitHub loop's follow-ups: a burst of CI events is one turn per
-- commit, reviews join one open batch, a turn is taken once, and CI's turns
-- stop at the limit until a person speaks.
do $$
declare
  p uuid := (select id from projects where full_name = 'immadsahin/runtime' limit 1);
  f uuid;
  r record;
  outcomes text := '';
begin
  if not (select fresh from queue_github_followup('ci', 42, p, 'immadsahin/runtime', 7, 'aaa', 0, 60)) then
    raise exception 'FAIL: a commit''s first CI event didn''t make its follow-up';
  end if;
  if (select fresh from queue_github_followup('ci', 42, p, 'immadsahin/runtime', 7, 'aaa', 0, 60)) then
    raise exception 'FAIL: a second CI event for a commit was taken for a new follow-up';
  end if;
  if (select count(*) from github_followups where kind = 'ci' and project_id = p) <> 1 then
    raise exception 'FAIL: a burst of CI events for one commit made more than one follow-up';
  end if;
  perform queue_github_followup('review', 42, p, 'immadsahin/runtime', 7, '', 5, 60);
  perform queue_github_followup('review', 42, p, 'immadsahin/runtime', 7, '', 3, 60);
  perform queue_github_followup('review', 42, p, 'immadsahin/runtime', 7, '', 5, 60);
  if (select review_ids from github_followups where kind = 'review' and project_id = p) <> '{3,5}' then
    raise exception 'FAIL: reviews didn''t join one batch';
  end if;

  select id into f from github_followups where kind = 'ci' and project_id = p;
  if exists (select 1 from claim_github_followup(f, 3)) then
    raise exception 'FAIL: a follow-up was taken before it was due';
  end if;
  update github_followups set due_at = now() - interval '1 second' where id = f;
  select * into r from claim_github_followup(f, 3);
  if r.outcome <> 'send' or r.turns <> 1 then
    raise exception 'FAIL: a due CI follow-up wasn''t sent as the first turn: %', r;
  end if;
  if exists (select 1 from claim_github_followup(f, 3)) then
    raise exception 'FAIL: a follow-up was taken twice';
  end if;
  -- Sent stays sent: the commit's CI isn't queued again.
  perform queue_github_followup('ci', 42, p, 'immadsahin/runtime', 7, 'aaa', 0, 60);
  if (select sent_at is null from github_followups where id = f) then
    raise exception 'FAIL: a sent CI follow-up was queued again';
  end if;

  for i in 2..5 loop
    perform queue_github_followup('ci', 42, p, 'immadsahin/runtime', 7, 'sha' || i, 0, 0);
    select id into f from github_followups where kind = 'ci' and project_id = p and head_sha = 'sha' || i;
    select * into r from claim_github_followup(f, 3);
    outcomes := outcomes || r.outcome || ' ';
  end loop;
  if outcomes <> 'send send capped quiet ' then
    raise exception 'FAIL: CI''s turns past the limit went as %', outcomes;
  end if;

  -- Re-run green before it went, then failing again: it opens again.
  perform queue_github_followup('ci', 42, p, 'immadsahin/runtime', 7, 'flaky', 0, 60);
  update github_followups set sent_at = now(), outcome = 'passed' where head_sha = 'flaky' and project_id = p;
  if not (select fresh from queue_github_followup('ci', 42, p, 'immadsahin/runtime', 7, 'flaky', 0, 60)) then
    raise exception 'FAIL: CI failing again after passing wasn''t queued again';
  end if;
  if (select sent_at is not null or outcome is not null from github_followups where head_sha = 'flaky' and project_id = p) then
    raise exception 'FAIL: a follow-up opened again kept how it went before';
  end if;

  -- A person spoke to the session working on it: CI counts from none.
  insert into github_session_links (project_id, kind, number, workspace_id)
  select p, 'pull', 7, w.id from workspaces w where w.project_id = p limit 1;
  perform reset_github_ci_turns((select workspace_id from github_session_links where project_id = p and number = 7 limit 1));
  if (select ci_turns from github_pr_loops where project_id = p and pr_number = 7) <> 0 then
    raise exception 'FAIL: a person''s word didn''t reset CI''s turns';
  end if;
  if has_table_privilege('authenticated', 'github_followups', 'select') or has_table_privilege('authenticated', 'github_loop_claims', 'select') then
    raise exception 'FAIL: members can read the GitHub loop''s records directly';
  end if;

  delete from github_session_links where project_id = p;
  delete from github_followups where project_id = p;
  delete from github_pr_loops where project_id = p;
  raise notice 'ok: GitHub follow-ups go once per burst, and CI stops at its limit';
end $$;

-- 50. Automations on a schedule: their schedules are saved with them, in one
-- step, and changing one makes the editor the runner as changing triggers
-- does (unchanged, their next times worked out again, it changes no one); a
-- run is once per key, a schedule's time as a commit's; and only a pull
-- request's run has a pull request.
do $$
declare
  p projects%rowtype;
  a uuid;
  n int;
begin
  select * into p from projects where full_name = 'immadsahin/runtime' and owner_id = '11111111-1111-1111-1111-111111111111';
  insert into organization_members (org_id, user_id, role)
  values (p.org_id, '22222222-2222-2222-2222-222222222222', 'admin') on conflict do nothing;
  a := create_automation(p.org_id, '11111111-1111-1111-1111-111111111111', 'Nightly', null, 'Look.', '{schedule}', true,
    array[p.id], '{"schedules": [
      {"kind": "weekly", "timezone": "Europe/Berlin", "spec": {"days": [1], "time": "09:00"}, "next_run_at": "2026-11-02T08:00:00Z"},
      {"kind": "cron", "timezone": "UTC", "spec": {"expression": "0 9 * * *"}, "next_run_at": null}]}');
  if (select count(*) from automation_schedules where automation_id = a) <> 2 then
    raise exception 'FAIL: an automation''s schedules weren''t saved with it';
  end if;
  perform update_automation(p.org_id, a, '22222222-2222-2222-2222-222222222222', null, null, null, true, null,
    '{"schedules": [
      {"kind": "weekly", "timezone": "Europe/Berlin", "spec": {"time": "09:00", "days": [1]}, "next_run_at": "2026-11-09T08:00:00Z"},
      {"kind": "cron", "timezone": "UTC", "spec": {"expression": "0 9 * * *"}, "next_run_at": "2026-11-03T09:00:00Z"}]}');
  if (select runs_as from automations where id = a) <> '11111111-1111-1111-1111-111111111111' then
    raise exception 'FAIL: schedules saved unchanged changed who the automation runs as';
  end if;
  if (select next_run_at from automation_schedules where automation_id = a and position = 1) is distinct from '2026-11-03T09:00:00Z' then
    raise exception 'FAIL: a schedule''s next time wasn''t worked out again';
  end if;
  perform update_automation(p.org_id, a, '22222222-2222-2222-2222-222222222222', null, null, null, null, null,
    '{"schedules": [{"kind": "weekly", "timezone": "Europe/Berlin", "spec": {"days": [2], "time": "09:00"}, "next_run_at": null}]}');
  if (select runs_as from automations where id = a) <> '22222222-2222-2222-2222-222222222222' then
    raise exception 'FAIL: changing a schedule didn''t make the editor the runner';
  end if;
  perform update_automation(p.org_id, a, '11111111-1111-1111-1111-111111111111', 'Renamed', null, null, null, null, '{}');
  if (select count(*) from automation_schedules where automation_id = a) <> 1 then
    raise exception 'FAIL: a change without schedules touched them';
  end if;

  insert into automation_runs (automation_id, project_id, trigger, dedupe_key, scheduled_for)
  values (a, p.id, 'schedule', 'schedule:2026-11-02T08:00:00.000Z', '2026-11-02T08:00:00Z');
  insert into automation_runs (automation_id, project_id, trigger, dedupe_key, scheduled_for)
  values (a, p.id, 'schedule', 'schedule:2026-11-02T08:00:00.000Z', '2026-11-02T08:00:00Z')
  on conflict (automation_id, project_id, dedupe_key) do nothing;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: a schedule''s time ran twice'; end if;
  begin
    insert into automation_runs (automation_id, project_id, trigger, dedupe_key, pr_number)
    values (a, p.id, 'pull_request.opened', 'pr:1:none', 1);
    raise exception 'FAIL: a pull request''s run without its commit was kept';
  exception when check_violation then null;
  end;
  begin
    insert into automation_runs (automation_id, project_id, trigger, dedupe_key) values (a, p.id, 'push', 'x');
    raise exception 'FAIL: a run with an unknown trigger was kept';
  exception when check_violation then null;
  end;
  begin
    update automations set triggers = '{push}' where id = a;
    raise exception 'FAIL: an unknown trigger was kept';
  exception when check_violation then null;
  end;
  if has_table_privilege('authenticated', 'automation_schedules', 'select') then
    raise exception 'FAIL: members can read automations'' schedules directly';
  end if;
  delete from automations where id = a;
  delete from organization_members where org_id = p.org_id and user_id = '22222222-2222-2222-2222-222222222222';
  raise notice 'ok: automations'' schedules save with them, and each time runs once';
end $$;

-- 51. An automation's webhook token: made with the trigger, in the same
-- step; kept when it's saved with one again (rotating is its own step); one
-- per automation, hashed and sealed together.
do $$
declare
  p projects%rowtype;
  a uuid;
  h text := repeat('a', 64);
begin
  select * into p from projects where full_name = 'immadsahin/runtime' and owner_id = '11111111-1111-1111-1111-111111111111';
  a := create_automation(p.org_id, '11111111-1111-1111-1111-111111111111', 'Alerts', null, 'Triage.', '{webhook}', true,
    array[p.id], jsonb_build_object('schedules', '[]'::jsonb, 'webhook', jsonb_build_object('hash', h, 'sealed', 'v1.x')));
  if (select webhook_token_hash from automations where id = a) is distinct from h then
    raise exception 'FAIL: a webhook automation was made without its token';
  end if;
  perform update_automation(p.org_id, a, '11111111-1111-1111-1111-111111111111', null, null, '{webhook}', null, null,
    jsonb_build_object('webhook', jsonb_build_object('hash', repeat('b', 64), 'sealed', 'v1.y')));
  if (select webhook_token_hash from automations where id = a) is distinct from h then
    raise exception 'FAIL: saving a webhook automation again replaced its token';
  end if;
  begin
    update automations set webhook_token_hash = 'not-a-hash' where id = a;
    raise exception 'FAIL: a webhook token that isn''t a hash was kept';
  exception when check_violation then null;
  end;
  begin
    update automations set webhook_token_sealed = null where id = a;
    raise exception 'FAIL: a webhook token''s hash was kept without its sealed copy';
  exception when check_violation then null;
  end;
  begin
    perform create_automation(p.org_id, '11111111-1111-1111-1111-111111111111', 'Copy', null, 'Triage.', '{webhook}', true,
      array[p.id], jsonb_build_object('webhook', jsonb_build_object('hash', h, 'sealed', 'v1.z')));
    raise exception 'FAIL: two automations shared a webhook token';
  exception when unique_violation then null;
  end;
  insert into automation_runs (automation_id, project_id, trigger, dedupe_key, context)
  values (a, p.id, 'webhook', 'webhook:key:deploy-1', '{"trigger": "webhook"}');
  delete from automations where id = a;
  raise notice 'ok: a webhook''s token is made with it, kept, and its own';
end $$;

-- 52. An automation's limits, kept as runs are recorded: a time it runs is
-- one key, on however many repositories; past its count nothing is
-- recorded, and reaching it switches it off (archived too, if it's to be);
-- switched on again, it counts afresh. In a debounce window, a trigger on
-- the same thing is taken into the run that waits, which is now its.
do $$
declare
  p projects%rowtype;
  a uuid;
  n int;
  waiting uuid;
begin
  select * into p from projects where full_name = 'immadsahin/runtime' and owner_id = '11111111-1111-1111-1111-111111111111';
  a := create_automation(p.org_id, '11111111-1111-1111-1111-111111111111', 'Twice', null, 'Look.', '{webhook}', true,
    array[p.id], '{"max_runs": 2, "archive_when_done": true}');
  select count(*) into n from record_automation_runs(jsonb_build_array(
    jsonb_build_object('automation_id', a, 'project_id', p.id, 'trigger', 'webhook', 'dedupe_key', 'webhook:1', 'subject', 'webhook')));
  if n <> 1 then raise exception 'FAIL: a first run under a limit wasn''t recorded'; end if;
  -- The same key again: nothing, and not counted twice.
  select count(*) into n from record_automation_runs(jsonb_build_array(
    jsonb_build_object('automation_id', a, 'project_id', p.id, 'trigger', 'webhook', 'dedupe_key', 'webhook:1', 'subject', 'webhook')));
  if n <> 0 then raise exception 'FAIL: a key was recorded twice'; end if;
  select count(*) into n from record_automation_runs(jsonb_build_array(
    jsonb_build_object('automation_id', a, 'project_id', p.id, 'trigger', 'webhook', 'dedupe_key', 'webhook:2', 'subject', 'webhook')));
  if n <> 1 then raise exception 'FAIL: a second run under a limit of two wasn''t recorded'; end if;
  if (select enabled or archived_at is null from automations where id = a) then
    raise exception 'FAIL: an automation that ran its count wasn''t switched off and archived';
  end if;
  select count(*) into n from record_automation_runs(jsonb_build_array(
    jsonb_build_object('automation_id', a, 'project_id', p.id, 'trigger', 'webhook', 'dedupe_key', 'webhook:3', 'subject', 'webhook')));
  if n <> 0 then raise exception 'FAIL: an automation past its count recorded a run'; end if;
  -- Switched on: unarchived, and counted afresh. (Its runs so far are from
  -- earlier transactions in life; in this one block, now() is one instant.)
  update automation_runs set created_at = created_at - interval '1 minute' where automation_id = a;
  perform update_automation(p.org_id, a, '11111111-1111-1111-1111-111111111111', null, null, null, true, null, '{}');
  if (select not enabled or archived_at is not null from automations where id = a) then
    raise exception 'FAIL: switching a done automation on didn''t bring it back';
  end if;
  select count(*) into n from record_automation_runs(jsonb_build_array(
    jsonb_build_object('automation_id', a, 'project_id', p.id, 'trigger', 'webhook', 'dedupe_key', 'webhook:4', 'subject', 'webhook')));
  if n <> 1 then raise exception 'FAIL: an automation switched on again didn''t count afresh'; end if;
  if automation_times_run(a) <> 1 then
    raise exception 'FAIL: automation_times_run counted % since it was switched on, not 1', automation_times_run(a);
  end if;
  begin
    update automations set archived_at = now(), enabled = true where id = a;
    raise exception 'FAIL: an archived automation was kept on';
  exception when check_violation then null;
  end;

  -- A debounce window: the second trigger joins the first's waiting run.
  perform update_automation(p.org_id, a, '11111111-1111-1111-1111-111111111111', null, null, null, null, null,
    '{"max_runs": null, "debounce_seconds": 300}');
  select run_id into waiting from record_automation_runs(jsonb_build_array(
    jsonb_build_object('automation_id', a, 'project_id', p.id, 'trigger', 'webhook', 'dedupe_key', 'webhook:5', 'subject', 'webhook',
      'context', '{"n": 5}'::jsonb)))
  where queued;
  if waiting is null then raise exception 'FAIL: a run in a debounce window didn''t wait'; end if;
  if (select run_id from record_automation_runs(jsonb_build_array(
    jsonb_build_object('automation_id', a, 'project_id', p.id, 'trigger', 'webhook', 'dedupe_key', 'webhook:6', 'subject', 'webhook',
      'context', '{"n": 6}'::jsonb)))) is distinct from waiting then
    raise exception 'FAIL: a trigger in the window wasn''t taken into the waiting run';
  end if;
  if (select combined <> 2 or context <> '{"n": 6}' or dedupe_key <> 'webhook:6' or not_before < now() + interval '4 minutes'
      from automation_runs where id = waiting) then
    raise exception 'FAIL: the waiting run isn''t the last trigger''s, its window started again';
  end if;
  if (select count(*) from automation_runs where automation_id = a and status = 'queued') <> 1 then
    raise exception 'FAIL: a debounce window kept two waiting runs';
  end if;
  -- The first trigger's key, taken in, still records nothing: started and
  -- all, a redelivery of it isn't a run of its own.
  update automation_runs set status = 'started' where id = waiting;
  select count(*) into n from record_automation_runs(jsonb_build_array(
    jsonb_build_object('automation_id', a, 'project_id', p.id, 'trigger', 'webhook', 'dedupe_key', 'webhook:5', 'subject', 'webhook')));
  if n <> 0 then raise exception 'FAIL: a key a debounce window took in was recorded again'; end if;
  -- Review requests of no one: never, however it's saved.
  begin
    perform update_automation(p.org_id, a, '11111111-1111-1111-1111-111111111111', null, null,
      '{pull_request.review_requested}', null, null, '{}');
    raise exception 'FAIL: the review requested trigger was kept with no reviewers';
  exception when check_violation then null;
  end;
  delete from automations where id = a;
  raise notice 'ok: an automation''s limits and debounce window hold as its runs are recorded';
end $$;

-- 53. Where a session stands: what the server's watch read of its agent is the
-- server's to write and its owner's to read; each person's marks are their
-- own; a pull request's state is one of three.
do $$
declare
  ws uuid;
begin
  select id into ws from workspaces where owner_id = '11111111-1111-1111-1111-111111111111' limit 1;
  insert into session_activity (workspace_id, owner_id, turn, waiting)
  values (ws, '11111111-1111-1111-1111-111111111111', 'working', 'question');
  begin
    update session_activity set waiting = 'coffee' where workspace_id = ws;
    raise exception 'FAIL: a session waited on something unknown';
  exception when check_violation then null;
  end;
  insert into session_marks (user_id, workspace_id, moved_to, moved_at)
  values ('11111111-1111-1111-1111-111111111111', ws, 'backlog', now());
  begin
    update session_marks set moved_to = 'somewhere' where workspace_id = ws;
    raise exception 'FAIL: a session was moved to an unknown group';
  exception when check_violation then null;
  end;
  begin
    update pull_requests set state = 'abandoned' where workspace_id = ws;
    if found then raise exception 'FAIL: a pull request took an unknown state'; end if;
  exception when check_violation then null;
  end;
end $$;

set role authed;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$
begin
  if exists (select 1 from session_activity where owner_id = '11111111-1111-1111-1111-111111111111') then
    raise exception 'FAIL: another user read a session''s activity';
  end if;
  if exists (select 1 from session_marks where user_id = '11111111-1111-1111-1111-111111111111') then
    raise exception 'FAIL: another user read someone''s marks';
  end if;
end $$;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$
declare
  ws uuid;
begin
  select workspace_id into ws from session_activity where owner_id = '11111111-1111-1111-1111-111111111111' limit 1;
  if ws is null then raise exception 'FAIL: an owner can''t read their session''s activity'; end if;
  begin
    update session_activity set turn = 'idle' where workspace_id = ws;
    if found then raise exception 'FAIL: an owner wrote the server''s read of their session'; end if;
  exception when insufficient_privilege then null;
  end;
  update session_marks set pinned_at = now() where workspace_id = ws;
  if not found then raise exception 'FAIL: an owner couldn''t pin their session'; end if;
end $$;
reset role;
do $$
begin
  delete from session_marks;
  delete from session_activity;
  raise notice 'ok: where a session stands is the server''s to read, and marks are each person''s own';
end $$;

-- 54. Notifications: each event once per person and session, theirs alone to
-- read; preferences each person's own, of known channels and kinds.
do $$
declare
  ws uuid;
  n int;
begin
  select id into ws from workspaces where owner_id = '11111111-1111-1111-1111-111111111111' limit 1;
  insert into session_notifications (user_id, workspace_id, kind, event_key, title, body)
  values ('11111111-1111-1111-1111-111111111111', ws, 'turn_done', 't1', 'Session', 'Done')
  on conflict on constraint session_notifications_once do nothing;
  insert into session_notifications (user_id, workspace_id, kind, event_key, title, body)
  values ('11111111-1111-1111-1111-111111111111', ws, 'turn_done', 't1', 'Session', 'Done')
  on conflict on constraint session_notifications_once do nothing;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: one event was recorded twice'; end if;
  begin
    insert into session_notifications (user_id, workspace_id, kind, event_key, title, body)
    values ('11111111-1111-1111-1111-111111111111', ws, 'gossip', 'x', 'Session', 'Hm');
    raise exception 'FAIL: a notification of an unknown kind was kept';
  exception when check_violation then null;
  end;
  insert into notification_preferences (user_id) values ('11111111-1111-1111-1111-111111111111');
  if (select browser and email = 'off' and not slack and cardinality(kinds) = 6
      from notification_preferences where user_id = '11111111-1111-1111-1111-111111111111') is not true then
    raise exception 'FAIL: notification preferences don''t default to the browser alone, for every kind';
  end if;
  begin
    update notification_preferences set kinds = '{turn_done,gossip}' where user_id = '11111111-1111-1111-1111-111111111111';
    raise exception 'FAIL: a preference for an unknown kind was kept';
  exception when check_violation then null;
  end;
  begin
    update notification_preferences set email = 'pigeon' where user_id = '11111111-1111-1111-1111-111111111111';
    raise exception 'FAIL: an unknown email choice was kept';
  exception when check_violation then null;
  end;
end $$;

set role authed;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$
begin
  if exists (select 1 from session_notifications where user_id = '11111111-1111-1111-1111-111111111111') then
    raise exception 'FAIL: another user read someone''s notifications';
  end if;
  if exists (select 1 from notification_preferences where user_id = '11111111-1111-1111-1111-111111111111') then
    raise exception 'FAIL: another user read someone''s notification preferences';
  end if;
end $$;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$
begin
  if not exists (select 1 from session_notifications where user_id = '11111111-1111-1111-1111-111111111111') then
    raise exception 'FAIL: a user can''t read their own notifications';
  end if;
  update session_notifications set body = 'changed' where user_id = '11111111-1111-1111-1111-111111111111';
  if found then raise exception 'FAIL: a user rewrote a notification'; end if;
  update notification_preferences set email = 'digest' where user_id = '11111111-1111-1111-1111-111111111111';
  if not found then raise exception 'FAIL: a user couldn''t change their own preferences'; end if;
end $$;
reset role;
do $$
begin
  delete from session_notifications;
  delete from notification_preferences;
  raise notice 'ok: notifications are recorded once each and read by their person alone';
end $$;

-- 55. A session's failed_at is when its status turned failed, and nothing
-- else moves it: a failure is told once, not again on a rename.
do $$
declare
  ws uuid;
  first timestamptz;
begin
  select id into ws from workspaces where owner_id = '11111111-1111-1111-1111-111111111111' limit 1;
  update workspaces set status = 'failed' where id = ws;
  select failed_at into first from workspaces where id = ws;
  if first is null then raise exception 'FAIL: a failed session has no failed_at'; end if;
  update workspaces set failed_at = '2000-01-01' where id = ws;
  update workspaces set title = 'renamed' where id = ws;
  update workspaces set status = 'failed' where id = ws;
  if (select failed_at from workspaces where id = ws) <> '2000-01-01' then
    raise exception 'FAIL: a write to a session already failed moved its failed_at';
  end if;
  update workspaces set status = 'ready', failed_at = null, title = null where id = ws;
  raise notice 'ok: failed_at marks when a session failed, and only that';
end $$;

-- 56. Missions (20261102200000_missions.sql, 20261102210000_mission_events.sql):
-- a Runner's parent is a Mission of its owner's, and a Mission's Runner's
-- pull request ready is a kind of notification.
do $$
declare
  owner uuid := '11111111-1111-1111-1111-111111111111';
  plain uuid;
  mission uuid;
  runner uuid;
begin
  select id into plain from workspaces where owner_id = owner limit 1;
  insert into workspaces (owner_id, project_id, branch, base_branch, provider, status, kind)
    select owner, project_id, 'mission-assert', base_branch, provider, 'ready', 'mission' from workspaces where id = plain
    returning id into mission;
  begin
    insert into workspaces (owner_id, project_id, branch, base_branch, provider, parent_mission_id)
      select owner, project_id, 'runner-of-plain', base_branch, provider, plain from workspaces where id = plain;
    raise exception 'FAIL: a session that isn''t a Mission took a Runner';
  exception when check_violation then null;
  end;
  insert into workspaces (owner_id, project_id, branch, base_branch, provider, parent_mission_id)
    select owner, project_id, 'runner-assert', base_branch, provider, mission from workspaces where id = plain
    returning id into runner;
  insert into session_notifications (user_id, workspace_id, kind, event_key, title, body)
    values (owner, mission, 'pr_ready', 'assert', 'A Mission', '#1 ready to review');
  delete from session_notifications where workspace_id = mission;
  delete from workspaces where id in (runner, mission);
  raise notice 'ok: a Runner''s parent is a Mission, and a pull request ready is told on it';
end $$;
