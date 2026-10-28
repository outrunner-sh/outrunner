-- Review of the GitHub follow-ups (20261102110000_github_followups.sql):
-- a commit's CI settled as passed (re-run green before it went) opens again
-- when it fails again, and queueing says whether this event made the
-- follow-up, so only that event waits for it to go.
--
-- Its return type changes, which `create or replace` can't do: dropped and
-- made again, in one transaction.
-- ---------------------------------------------------------------------------

drop function if exists queue_github_followup(text, bigint, uuid, text, integer, text, bigint, integer);

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
returns table (followup_id uuid, fresh boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  prior github_followups%rowtype;
  queued uuid;
begin
  if followup_kind = 'ci' then
    select * into prior from github_followups
    where kind = 'ci' and project_id = target_project and pr_number = target_pr and head_sha = commit_sha;
    insert into github_followups (kind, installation_id, project_id, repo_full_name, pr_number, head_sha, due_at)
    values ('ci', target_installation, target_project, target_repo, target_pr, commit_sha,
            now() + make_interval(secs => delay_seconds))
    on conflict (project_id, pr_number, head_sha) where kind = 'ci'
    do update set
      due_at = case when github_followups.sent_at is null
                    then greatest(github_followups.due_at, excluded.due_at) else excluded.due_at end,
      first_at = case when github_followups.sent_at is null then github_followups.first_at else now() end,
      sent_at = null,
      outcome = null
      where github_followups.sent_at is null or github_followups.outcome = 'passed'
    returning id into queued;
    -- Sent already: nothing queued.
    if queued is null then
      return;
    end if;
    -- Made now, or opened again: this event is its first.
    return query select queued, prior.id is null or prior.sent_at is not null;
  elsif followup_kind = 'review' then
    select * into prior from github_followups
    where kind = 'review' and project_id = target_project and pr_number = target_pr and sent_at is null;
    insert into github_followups (kind, installation_id, project_id, repo_full_name, pr_number, review_ids, due_at)
    values ('review', target_installation, target_project, target_repo, target_pr, array[review_id],
            now() + make_interval(secs => delay_seconds))
    on conflict (project_id, pr_number) where kind = 'review' and sent_at is null
    do update set
      review_ids = (select array_agg(distinct r order by r) from unnest(github_followups.review_ids || excluded.review_ids) r),
      due_at = greatest(github_followups.due_at, excluded.due_at)
    returning id into queued;
    return query select queued, prior.id is null;
  else
    raise exception 'unknown follow-up kind %', followup_kind using errcode = 'check_violation';
  end if;
end;
$$;

revoke all on function queue_github_followup(text, bigint, uuid, text, integer, text, bigint, integer) from public, anon, authenticated;
grant execute on function queue_github_followup(text, bigint, uuid, text, integer, text, bigint, integer) to service_role;
