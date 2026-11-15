-- Phase 3: `!assign @person` records who owns a thread's open request (and so
-- its Ships). The Mission keeps working; Ships still run as the owner.
alter table mission_slack_requests add column if not exists assignee_user_id uuid references auth.users (id) on delete set null;
alter table mission_slack_requests add column if not exists assigned_by uuid references auth.users (id) on delete set null;
alter table mission_slack_requests add column if not exists assigned_at timestamptz;

-- `!new <task>` requests the Mission wasn't told of, for the tick
-- (unannouncedRequests, lib/missions/slack-store.ts): open, untold, keyed
-- `new:`. The tick tells each once its root post went. A mention's request
-- (told as it's taken, never marked told) is never one.
create or replace function unannounced_new_requests(made_before timestamptz, max_rows integer)
returns setof mission_slack_requests
language sql
stable
set search_path = public
as $$
  select *
  from mission_slack_requests
  where source = 'slack'
    and request_key like 'new:%'
    and status = 'open'
    and announced_at is null
    and created_at < made_before
  order by created_at asc
  limit max_rows;
$$;

revoke all on function unannounced_new_requests(timestamptz, integer) from public, anon, authenticated;
grant execute on function unannounced_new_requests(timestamptz, integer) to service_role;

create index if not exists mission_slack_requests_untold_new_idx on mission_slack_requests (created_at)
  where source = 'slack' and status = 'open' and announced_at is null and request_key like 'new:%';
