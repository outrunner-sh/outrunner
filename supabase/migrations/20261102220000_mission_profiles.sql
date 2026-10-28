-- How a Mission shows in the sidebar (docs/missions.md): its icon, chosen
-- from the app's set, and its place in the Missions section, where its owner
-- drags it. Read and written by the app's routes for the Mission's owner,
-- with the service role.
-- ---------------------------------------------------------------------------

create table if not exists mission_profiles (
  mission_id uuid primary key references workspaces (id) on delete cascade,
  icon text check (icon ~ '^[a-z][a-z0-9-]{0,39}$'),
  position integer,
  updated_at timestamptz not null default now()
);

drop trigger if exists mission_profiles_set_updated_at on mission_profiles;
create trigger mission_profiles_set_updated_at
  before update on mission_profiles
  for each row execute function set_updated_at();

alter table mission_profiles enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table mission_profiles from anon, authenticated;

-- Each Runner's latest event, for the Runners pane: what it last needed
-- (lib/missions/view.deps.ts), however many events its Mission's other
-- Runners have.
create or replace function latest_mission_events(runner_ids uuid[])
  returns table (runner_id uuid, kind text, payload jsonb, created_at timestamptz)
  language sql
  stable
  security definer
  set search_path = public
as $$
  select distinct on (e.runner_id) e.runner_id, e.kind, e.payload, e.created_at
    from mission_events e
    where e.runner_id = any (runner_ids)
    order by e.runner_id, e.created_at desc;
$$;

revoke all on function latest_mission_events(uuid[]) from public, anon, authenticated;
