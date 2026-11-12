-- Issue trackers (Linear now, Jira next; docs/linear-app.md): an org's admin
-- connects a tracker and its teams, and what happens there reaches triage.
--
--   tracker_installations      one per Linear workspace (or Jira site), global,
--                              as github_installations has been since
--                              20261104100000_shared_github_installations.sql:
--                              one company can have several Outrunner orgs
--   org_tracker_installations  which orgs use it
--   tracker_scopes             which org owns a team: at most one
--   tracker_rules              what in that team is filed to triage
--   tracker_links              which Outrunner user a tracker user is, made only
--                              by signing in to the tracker as them
--   tracker_events_seen        a redelivered webhook acts once
--
-- All the server's alone (RLS on, no policy, every grant revoked), reached
-- through lib/db/trackers.ts. Tokens are sealed (lib/crypto/secret-box.ts).
--
-- Additive only: code from before this runs on it unchanged, and code from
-- after it finds nothing connected (and stores nothing new on an item) until
-- it's applied.
-- ---------------------------------------------------------------------------

alter type work_item_source add value if not exists 'linear';
alter type work_item_source add value if not exists 'jira';

-- Who wrote the issue, as the tracker names them ("Ana"), as
-- work_item_notes.author does for a note.
alter table work_items add column if not exists source_author text
  check (char_length(source_author) <= 200);

-- The comment a note is (linear:comment:<id>), so an edit or a delete in the
-- tracker finds it; also what a redelivered event's note is, so it's added once.
alter table work_item_notes add column if not exists source_ref text
  check (char_length(source_ref) <= 300);

create unique index if not exists work_item_notes_item_source_ref_key
  on work_item_notes (item_id, source_ref) where source_ref is not null;
create index if not exists work_item_notes_org_source_ref_idx
  on work_item_notes (org_id, source_ref) where source_ref is not null;

-- ---------------------------------------------------------------------------

create table if not exists tracker_installations (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('linear', 'jira')),
  -- Linear's organization id, or Jira's cloudId.
  external_id text not null check (char_length(external_id) between 1 and 200),
  site_url text check (char_length(site_url) <= 2000),
  name text check (char_length(name) <= 200),
  -- Our own user there (Linear's app user, Jira's service account): events it
  -- made are dropped, so what we write never comes back to us.
  app_user_id text check (char_length(app_user_id) <= 200),
  -- Null once disconnected: nothing to leak, and nothing to refresh.
  access_token_ciphertext text,
  refresh_token_ciphertext text,
  token_expires_at timestamptz,
  refresh_expires_at timestamptz,
  -- Held while one caller refreshes (both trackers rotate refresh tokens, so
  -- two at once would kill the install): a lease, as a transaction can't stay
  -- open across the provider's HTTP call. lib/trackers/tokens.ts.
  refreshing_until timestamptz,
  -- Jira's webhook, which expires after 30 days.
  webhook_id text,
  webhook_expires_at timestamptz,
  installed_by uuid references auth.users (id) on delete set null,
  -- Revoked there, or its last org left. Rules stop; the card offers Reconnect.
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tracker_installations_provider_external_unique unique (provider, external_id)
);

-- What the tick refreshes.
create index if not exists tracker_installations_refresh_idx
  on tracker_installations (token_expires_at) where disconnected_at is null;

drop trigger if exists tracker_installations_set_updated_at on tracker_installations;
create trigger tracker_installations_set_updated_at
  before update on tracker_installations
  for each row execute function set_updated_at();

create table if not exists org_tracker_installations (
  org_id uuid not null references organizations (id) on delete cascade,
  installation_id uuid not null references tracker_installations (id) on delete cascade,
  connected_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (org_id, installation_id)
);

create index if not exists org_tracker_installations_installation_idx
  on org_tracker_installations (installation_id);

create table if not exists tracker_scopes (
  id uuid primary key default gen_random_uuid(),
  installation_id uuid not null,
  org_id uuid not null,
  -- A Linear team's id, or a Jira project's.
  external_team_id text not null check (char_length(external_team_id) between 1 and 200),
  name text check (char_length(name) <= 200),
  set_by uuid references auth.users (id) on delete set null,
  -- The tracker's state for a session started and for its PR open
  -- ({"started": <id>, "inReview": <id>}); null is off. Delegations only.
  state_map jsonb,
  -- A repository for delegations. Null: none, or its project was removed.
  default_project_id uuid,
  -- Sessions a Linear or Jira rule starts, with no person delegating: they
  -- spend members' accounts, so an org admin turns them on, and caps them.
  accept_rule_sessions boolean not null default false,
  rule_sessions_per_day integer not null default 20 check (rule_sessions_per_day between 1 and 500),
  -- Today's count (UTC), taken in one conditional update.
  rule_sessions_on date,
  rule_sessions_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tracker_scopes_team_unique unique (installation_id, external_team_id),
  constraint tracker_scopes_org_id_unique unique (org_id, id),
  constraint tracker_scopes_org_installation_fkey
    foreign key (org_id, installation_id)
    references org_tracker_installations (org_id, installation_id) on delete cascade,
  -- The org's own projects only, as set_automation_repos checks for automations.
  constraint tracker_scopes_org_project_fkey
    foreign key (org_id, default_project_id)
    references projects (org_id, id) on delete set null (default_project_id)
);

create index if not exists tracker_scopes_org_idx on tracker_scopes (org_id);
create index if not exists tracker_scopes_default_project_idx
  on tracker_scopes (org_id, default_project_id) where default_project_id is not null;

drop trigger if exists tracker_scopes_set_updated_at on tracker_scopes;
create trigger tracker_scopes_set_updated_at
  before update on tracker_scopes
  for each row execute function set_updated_at();

create table if not exists tracker_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  scope_id uuid not null,
  -- The first enabled match, lowest first, files the issue.
  position integer not null default 0,
  -- Null is Unsorted. A project removed leaves the rule, filing to Unsorted.
  project_id uuid,
  -- The tracker's ids, never names (they change). AND across these, OR within
  -- one, and an empty one means any: lib/trackers/rules.ts.
  labels text[] not null default '{}' check (cardinality(labels) <= 20),
  states text[] not null default '{}' check (cardinality(states) <= 20),
  priorities text[] not null default '{}' check (cardinality(priorities) <= 20),
  issue_types text[] not null default '{}' check (cardinality(issue_types) <= 20),
  assignees text[] not null default '{}' check (cardinality(assignees) <= 20),
  -- Who filing falls back to. Gone, or no longer able to: the rule stops.
  set_by uuid references auth.users (id) on delete set null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tracker_rules_org_scope_fkey
    foreign key (org_id, scope_id)
    references tracker_scopes (org_id, id) on delete cascade,
  constraint tracker_rules_org_project_fkey
    foreign key (org_id, project_id)
    references projects (org_id, id) on delete set null (project_id)
);

create index if not exists tracker_rules_scope_idx on tracker_rules (scope_id, position);
create index if not exists tracker_rules_project_idx
  on tracker_rules (org_id, project_id) where project_id is not null;

drop trigger if exists tracker_rules_set_updated_at on tracker_rules;
create trigger tracker_rules_set_updated_at
  before update on tracker_rules
  for each row execute function set_updated_at();

create table if not exists tracker_links (
  installation_id uuid not null references tracker_installations (id) on delete cascade,
  external_user_id text not null check (char_length(external_user_id) between 1 and 200),
  owner_id uuid not null references auth.users (id) on delete cascade,
  external_name text check (char_length(external_name) <= 200),
  created_at timestamptz not null default now(),
  primary key (installation_id, external_user_id)
);

create index if not exists tracker_links_owner_idx on tracker_links (owner_id);

-- Trackers send an event again when it isn't answered in time. Old rows are
-- pruned by the tick.
create table if not exists tracker_events_seen (
  event_id text primary key,
  created_at timestamptz not null default now()
);

create index if not exists tracker_events_seen_created_idx on tracker_events_seen (created_at);

-- No policy, on purpose: see 20260928120000_user_credentials.sql.
alter table tracker_installations enable row level security;
alter table org_tracker_installations enable row level security;
alter table tracker_scopes enable row level security;
alter table tracker_rules enable row level security;
alter table tracker_links enable row level security;
alter table tracker_events_seen enable row level security;

revoke all on table tracker_installations from anon, authenticated;
revoke all on table org_tracker_installations from anon, authenticated;
revoke all on table tracker_scopes from anon, authenticated;
revoke all on table tracker_rules from anon, authenticated;
revoke all on table tracker_links from anon, authenticated;
revoke all on table tracker_events_seen from anon, authenticated;
