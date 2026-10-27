-- Triage: work items kept in Outrunner, so the work stays beside the sessions
-- that do it rather than in Linear. A note captured anywhere (the app, Slack,
-- the CLI) lands as a work item in `triage`; more notes collect on it; it is
-- then accepted (todo), declined, or marked a duplicate, and a session can be
-- started from it (in_progress → done).
--
-- An item belongs to a workspace (a projects row), or to none yet: a capture
-- that names no repository is "Unsorted" until it is triaged.
-- ---------------------------------------------------------------------------

do $$ begin
  create type work_item_status as enum ('triage', 'todo', 'in_progress', 'done', 'declined', 'duplicate');
exception when duplicate_object then null; end $$;

do $$ begin
  create type work_item_source as enum ('app', 'slack', 'cli', 'api');
exception when duplicate_object then null; end $$;

create table if not exists work_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- Null is Unsorted. Removing the repository keeps its items, unsorted.
  project_id uuid,
  -- Per owner, shown as OR-<number>. Set by work_items_set_number.
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
  -- The session started from it.
  workspace_id uuid,
  triaged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint work_items_owner_id_unique unique (owner_id, id),
  constraint work_items_owner_number_unique unique (owner_id, number),
  constraint work_items_owner_source_ref_unique unique (owner_id, source_ref),
  constraint work_items_owner_project_fkey
    foreign key (owner_id, project_id)
    references projects (owner_id, id) on delete set null (project_id),
  constraint work_items_owner_workspace_fkey
    foreign key (owner_id, workspace_id)
    references workspaces (owner_id, id) on delete set null (workspace_id),
  constraint work_items_owner_duplicate_fkey
    foreign key (owner_id, duplicate_of)
    references work_items (owner_id, id) on delete set null (duplicate_of),
  constraint work_items_not_own_duplicate check (duplicate_of is null or duplicate_of <> id)
);

create index if not exists work_items_owner_status_idx on work_items (owner_id, status, updated_at desc);
create index if not exists work_items_project_idx on work_items (project_id);
-- For the `on delete set null` of a session or an item, which would otherwise
-- scan the table.
create index if not exists work_items_owner_workspace_idx
  on work_items (owner_id, workspace_id) where workspace_id is not null;
create index if not exists work_items_owner_duplicate_idx
  on work_items (owner_id, duplicate_of) where duplicate_of is not null;

-- The next number for the owner. Serialized per owner, so two captures at
-- once never take the same one.
create or replace function work_items_set_number()
returns trigger
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtext('work_items:' || new.owner_id::text));
  select coalesce(max(number), 0) + 1 into new.number from work_items where owner_id = new.owner_id;
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
  owner_id uuid not null references auth.users (id) on delete cascade,
  item_id uuid not null,
  body text not null check (char_length(body) between 1 and 100000),
  source work_item_source not null default 'app',
  source_url text,
  -- Who wrote it where it came from ("@immad in #eng"); null is the owner.
  author text check (char_length(author) <= 200),
  created_at timestamptz not null default now(),

  constraint work_item_notes_owner_item_fkey
    foreign key (owner_id, item_id)
    references work_items (owner_id, id) on delete cascade
);

create index if not exists work_item_notes_item_idx on work_item_notes (item_id, created_at);

alter table work_items enable row level security;
alter table work_item_notes enable row level security;

drop policy if exists work_items_owner_all on work_items;
create policy work_items_owner_all on work_items
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists work_item_notes_owner_all on work_item_notes;
create policy work_item_notes_owner_all on work_item_notes
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- Which Outrunner user a Slack user is, made by that user confirming it while
-- signed in (never by typing a member ID, which would let anyone receive
-- someone else's captures). Same treatment as cli_tokens: RLS on with no
-- policy and every grant revoked, reached only by the service role through
-- lib/db/slack-links.ts.
create table if not exists slack_links (
  team_id text not null check (char_length(team_id) between 1 and 64),
  slack_user_id text not null check (char_length(slack_user_id) between 1 and 64),
  owner_id uuid not null references auth.users (id) on delete cascade,
  team_name text,
  slack_user_name text,
  created_at timestamptz not null default now(),
  primary key (team_id, slack_user_id)
);

create index if not exists slack_links_owner_idx on slack_links (owner_id);

alter table slack_links enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table slack_links from anon, authenticated;
