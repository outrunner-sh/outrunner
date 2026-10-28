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
