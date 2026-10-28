-- Triage: work items kept in Outrunner, so the work stays beside the sessions
-- that do it rather than in Linear. A note captured anywhere (the app, Slack,
-- the CLI) lands as a work item in `triage`; more notes collect on it; it is
-- then accepted (todo), declined, or marked a duplicate, and a session can be
-- started from it (in_progress → done).
--
-- Items are their org's, as projects are, and follow the project's access
-- (20261028145000_org_access.sql):
--
--   read  - see the item, add notes, start a session from it
--   write - also triage it: edit, accept, decline, duplicate, move it
--
-- An item in no project yet ("Unsorted") is seen by every member, and
-- triaged by those with write on all of the org's projects.
--
-- Every write is the server's (service role, lib/db/work-items.ts), which
-- checks the level first (lib/triage/access.ts); members read through the
-- policies below, which say the same.
-- ---------------------------------------------------------------------------

do $$ begin
  create type work_item_status as enum ('triage', 'todo', 'in_progress', 'done', 'declined', 'duplicate');
exception when duplicate_object then null; end $$;

do $$ begin
  create type work_item_source as enum ('app', 'slack', 'cli', 'api');
exception when duplicate_object then null; end $$;

create table if not exists work_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  -- Who captured it (the Slack user's linked account, for a Slack capture).
  created_by uuid references auth.users (id) on delete set null,
  -- Null is Unsorted. A project removed leaves its items, unsorted.
  project_id uuid,
  -- Per org, shown as OR-<number>. Set by work_items_set_number.
  number integer not null default 0,
  title text not null check (char_length(title) between 1 and 200),
  -- Markdown.
  body text not null default '' check (char_length(body) <= 100000),
  status work_item_status not null default 'triage',
  source work_item_source not null default 'app',
  -- Where it came from (a Slack permalink), for a way back.
  source_url text,
  -- What a capture is the same as: a second capture with the same ref is a
  -- note on this item, not a new one (a Slack thread: slack:<team>/<channel>/<ts>).
  source_ref text check (char_length(source_ref) <= 300),
  duplicate_of uuid,
  -- The session started from it (its starter's, as every session is).
  workspace_id uuid references workspaces (id) on delete set null,
  triaged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint work_items_org_id_unique unique (org_id, id),
  constraint work_items_org_number_unique unique (org_id, number),
  constraint work_items_org_source_ref_unique unique (org_id, source_ref),
  constraint work_items_org_project_fkey
    foreign key (org_id, project_id)
    references projects (org_id, id) on delete set null (project_id),
  constraint work_items_org_duplicate_fkey
    foreign key (org_id, duplicate_of)
    references work_items (org_id, id) on delete set null (duplicate_of),
  constraint work_items_not_own_duplicate check (duplicate_of is null or duplicate_of <> id)
);

create index if not exists work_items_org_status_idx on work_items (org_id, status, updated_at desc);
create index if not exists work_items_org_project_idx on work_items (org_id, project_id);
-- For the `on delete set null` of a session or an item, which would otherwise
-- scan the table.
create index if not exists work_items_workspace_idx on work_items (workspace_id) where workspace_id is not null;
create index if not exists work_items_org_duplicate_idx
  on work_items (org_id, duplicate_of) where duplicate_of is not null;

-- The next number in the org. Serialized per org, so two captures at once
-- never take the same one.
create or replace function work_items_set_number()
returns trigger
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtext('work_items:' || new.org_id::text));
  select coalesce(max(number), 0) + 1 into new.number from work_items where org_id = new.org_id;
  return new;
end;
$$;

drop trigger if exists work_items_set_number on work_items;
create trigger work_items_set_number
  before insert on work_items
  for each row execute function work_items_set_number();

drop trigger if exists work_items_set_updated_at on work_items;
create trigger work_items_set_updated_at
  before update on work_items
  for each row execute function set_updated_at();

-- Notes: an item's feed, appended to and never edited.
create table if not exists work_item_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  item_id uuid not null,
  -- The member who added it (the Slack user's linked account, from Slack).
  author_id uuid references auth.users (id) on delete set null,
  body text not null check (char_length(body) between 1 and 100000),
  source work_item_source not null default 'app',
  source_url text,
  -- Who wrote it where it came from ("ana (#eng)"); null is the member.
  author text check (char_length(author) <= 200),
  created_at timestamptz not null default now(),

  constraint work_item_notes_org_item_fkey
    foreign key (org_id, item_id)
    references work_items (org_id, id) on delete cascade
);

create index if not exists work_item_notes_item_idx on work_item_notes (item_id, created_at);

-- ---------------------------------------------------------------------------
-- What the signed-in user may read: the org's items in projects they may
-- read, and its Unsorted ones. Writes are the server's alone.
-- ---------------------------------------------------------------------------
alter table work_items enable row level security;
alter table work_item_notes enable row level security;

drop policy if exists work_items_member_read on work_items;
create policy work_items_member_read on work_items
  for select using (
    org_id in (select my_org_ids())
    and (project_id is null or my_project_level(project_id) is not null)
  );

drop policy if exists work_item_notes_member_read on work_item_notes;
create policy work_item_notes_member_read on work_item_notes
  for select using (
    exists (select 1 from work_items i where i.id = item_id)
  );

revoke insert, update, delete on table work_items from anon, authenticated;
revoke insert, update, delete on table work_item_notes from anon, authenticated;
revoke all on table work_items from anon;
revoke all on table work_item_notes from anon;

-- Every project level `member` has in `target_org`, in one query: the triage
-- page decides what each item allows from it (lib/triage/access.ts). Only
-- projects with a level are listed. The server's alone, as project_level.
create or replace function triage_project_levels(member uuid, target_org uuid)
returns table (project_id uuid, level text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, public.project_level(member, p.id)
  from public.projects p
  where p.org_id = target_org and public.project_level(member, p.id) is not null
$$;

revoke all on function triage_project_levels(uuid, uuid) from public, anon, authenticated;
grant execute on function triage_project_levels(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Which Outrunner user a Slack user is, and the org their captures go to.
-- Made by the user signing in with Slack as that Slack user (Sign in with
-- Slack), never by typing a member ID or confirming a link someone forwarded.
-- Same treatment as cli_tokens: RLS on with no policy and every grant
-- revoked, reached only by the service role through lib/db/slack-links.ts.
-- ---------------------------------------------------------------------------
create table if not exists slack_links (
  team_id text not null check (char_length(team_id) between 1 and 64),
  slack_user_id text not null check (char_length(slack_user_id) between 1 and 64),
  owner_id uuid not null references auth.users (id) on delete cascade,
  org_id uuid not null references organizations (id) on delete cascade,
  team_name text,
  slack_user_name text,
  created_at timestamptz not null default now(),
  primary key (team_id, slack_user_id),
  constraint slack_links_member_fkey
    foreign key (org_id, owner_id) references organization_members (org_id, user_id) on delete cascade
);

create index if not exists slack_links_owner_idx on slack_links (owner_id);

alter table slack_links enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table slack_links from anon, authenticated;
