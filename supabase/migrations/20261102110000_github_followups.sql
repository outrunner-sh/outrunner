-- The GitHub agent loop's follow-ups (lib/github/followups.ts): CI failing
-- on a pull request a session works on, and reviews of it, sent to that
-- session as one turn each, not one per event. A burst of events waits
-- here until it settles (due_at), then goes once.
--
-- The server's alone (service role).
-- ---------------------------------------------------------------------------

create table if not exists github_followups (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('ci', 'review')),
  installation_id bigint not null,
  project_id uuid not null references projects (id) on delete cascade,
  repo_full_name text not null,
  pr_number integer not null check (pr_number > 0),
  -- CI's: the commit that failed. One turn per commit, ever. A review's: ''.
  head_sha text not null default '',
  -- A review batch's reviews, by GitHub's id.
  review_ids bigint[] not null default '{}',
  -- When the first event came, and when the burst is taken as over: each
  -- event of it puts that later.
  first_at timestamptz not null default now(),
  due_at timestamptz not null,
  -- When it was taken to send, or settled without: and how it went.
  sent_at timestamptz,
  outcome text,
  created_at timestamptz not null default now()
);

-- One CI turn per pull request and commit, whatever GitHub redelivers.
create unique index if not exists github_followups_ci_key
  on github_followups (project_id, pr_number, head_sha) where kind = 'ci';
-- One review batch open per pull request at a time: reviews join it.
create unique index if not exists github_followups_review_open
  on github_followups (project_id, pr_number) where kind = 'review' and sent_at is null;
create index if not exists github_followups_due_idx on github_followups (due_at) where sent_at is null;

alter table github_followups enable row level security;
revoke all on table github_followups from anon, authenticated;

-- How many CI turns in a row a pull request's session has had with no word
-- from a person in between: at the limit, CI failing waits for one.
create table if not exists github_pr_loops (
  project_id uuid not null references projects (id) on delete cascade,
  pr_number integer not null check (pr_number > 0),
  ci_turns integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (project_id, pr_number)
);

alter table github_pr_loops enable row level security;
revoke all on table github_pr_loops from anon, authenticated;

-- Queue a follow-up, or add to the one waiting: CI's for its commit (one
-- already sent stays sent), a review into the pull request's open batch.
-- Either way the burst is over `delay_seconds` after its latest event.
create or replace function queue_github_followup(
  followup_kind text,
  target_installation bigint,
  target_project uuid,
  target_repo text,
  target_pr integer,
  commit_sha text,
  review_id bigint,
  delay_seconds integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if followup_kind = 'ci' then
    insert into github_followups (kind, installation_id, project_id, repo_full_name, pr_number, head_sha, due_at)
    values ('ci', target_installation, target_project, target_repo, target_pr, commit_sha,
            now() + make_interval(secs => delay_seconds))
    on conflict (project_id, pr_number, head_sha) where kind = 'ci'
    do update set due_at = greatest(github_followups.due_at, excluded.due_at)
      where github_followups.sent_at is null;
  elsif followup_kind = 'review' then
    insert into github_followups (kind, installation_id, project_id, repo_full_name, pr_number, review_ids, due_at)
    values ('review', target_installation, target_project, target_repo, target_pr, array[review_id],
            now() + make_interval(secs => delay_seconds))
    on conflict (project_id, pr_number) where kind = 'review' and sent_at is null
    do update set
      review_ids = (select array_agg(distinct r order by r) from unnest(github_followups.review_ids || excluded.review_ids) r),
      due_at = greatest(github_followups.due_at, excluded.due_at);
  else
    raise exception 'unknown follow-up kind %', followup_kind using errcode = 'check_violation';
  end if;
end;
$$;

-- Take a due follow-up to send, once: null when it's taken or not due. A
-- review's is always sent; CI's counts a turn for its pull request, and
-- past `max_turns` in a row is 'capped' (once, to say so) then 'quiet'.
create or replace function claim_github_followup(target uuid, max_turns integer)
returns table (outcome text, turns integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  f github_followups%rowtype;
  n integer;
begin
  update github_followups set sent_at = now()
  where id = target and sent_at is null and due_at <= now()
  returning * into f;
  if not found then
    return;
  end if;
  if f.kind = 'review' then
    return query select 'send'::text, 0;
    return;
  end if;
  insert into github_pr_loops (project_id, pr_number) values (f.project_id, f.pr_number)
  on conflict (project_id, pr_number) do nothing;
  update github_pr_loops set ci_turns = ci_turns + 1, updated_at = now()
  where project_id = f.project_id and pr_number = f.pr_number and ci_turns <= max_turns
  returning ci_turns into n;
  if n is null then
    return query select 'quiet'::text, max_turns;
  elsif n > max_turns then
    return query select 'capped'::text, max_turns;
  else
    return query select 'send'::text, n;
  end if;
end;
$$;

-- A person said something to a session: the CI turns of the pull requests
-- it works on start counting again.
create or replace function reset_github_ci_turns(target_workspace uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update github_pr_loops l set ci_turns = 0, updated_at = now()
  where l.ci_turns > 0 and (l.project_id, l.pr_number) in (
    select p.project_id, p.github_number from pull_requests p where p.workspace_id = target_workspace
    union
    select g.project_id, g.number from github_session_links g where g.workspace_id = target_workspace and g.kind = 'pull'
  );
$$;

revoke all on function queue_github_followup(text, bigint, uuid, text, integer, text, bigint, integer) from public, anon, authenticated;
revoke all on function claim_github_followup(uuid, integer) from public, anon, authenticated;
revoke all on function reset_github_ci_turns(uuid) from public, anon, authenticated;
grant execute on function queue_github_followup(text, bigint, uuid, text, integer, text, bigint, integer) to service_role;
grant execute on function claim_github_followup(uuid, integer) to service_role;
grant execute on function reset_github_ci_turns(uuid) to service_role;
