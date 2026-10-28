-- Outrunner in Slack: an agent that talks with people in a thread, works out
-- what they need, and files it to triage as a precise work item with a ready
-- session prompt (docs/slack-app.md). Every table here is the server's alone:
-- RLS on, no policy, every grant revoked, reached through lib/db/slack-agent.ts.
-- ---------------------------------------------------------------------------

-- The app's install in a Slack workspace: its bot, and the bot token the
-- agent posts with, sealed (lib/crypto/secret-box.ts).
create table if not exists slack_installations (
  team_id text primary key check (char_length(team_id) between 1 and 64),
  team_name text,
  bot_user_id text not null,
  bot_token_ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists slack_installations_set_updated_at on slack_installations;
create trigger slack_installations_set_updated_at
  before update on slack_installations
  for each row execute function set_updated_at();

-- A thread the agent is in: whose org it files to (the person who started
-- it), where the conversation stands, the spec it last proposed, and the item
-- and session that came of it.
create table if not exists slack_conversations (
  id uuid primary key default gen_random_uuid(),
  team_id text not null,
  channel_id text not null,
  thread_ts text not null,
  org_id uuid not null references organizations (id) on delete cascade,
  started_by uuid references auth.users (id) on delete set null,
  state text not null default 'gathering'
    check (state in ('gathering', 'proposed', 'filed', 'started')),
  -- How many times the agent has asked questions: it proposes by the third.
  rounds integer not null default 0,
  proposal jsonb,
  -- The spec card's message, to update when it's filed.
  proposal_ts text,
  item_id uuid references work_items (id) on delete set null,
  workspace_id uuid references workspaces (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint slack_conversations_thread_unique unique (team_id, channel_id, thread_ts)
);

create index if not exists slack_conversations_item_idx on slack_conversations (item_id) where item_id is not null;

drop trigger if exists slack_conversations_set_updated_at on slack_conversations;
create trigger slack_conversations_set_updated_at
  before update on slack_conversations
  for each row execute function set_updated_at();

-- Slack sends an event again when it isn't answered in time: each is handled
-- once. Old rows are pruned as new ones come.
create table if not exists slack_events_seen (
  event_id text primary key,
  created_at timestamptz not null default now()
);

-- The org's own key for Outrunner's models: what the Slack agent's model
-- calls run on, so the org pays for them rather than whoever is in the
-- thread. Capped by OpenRouter; sealed like a user's key.
create table if not exists org_model_keys (
  org_id uuid primary key references organizations (id) on delete cascade,
  key_ciphertext text,
  key_hash text,
  created_at timestamptz not null default now()
);

-- The session prompt a work item was filed with (the Slack agent writes
-- one); "Start session" uses it as written.
alter table work_items add column if not exists prompt text check (char_length(prompt) <= 100000);

alter table slack_installations enable row level security;
alter table slack_conversations enable row level security;
alter table slack_events_seen enable row level security;
alter table org_model_keys enable row level security;
-- No policies, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table slack_installations from anon, authenticated;
revoke all on table slack_conversations from anon, authenticated;
revoke all on table slack_events_seen from anon, authenticated;
revoke all on table org_model_keys from anon, authenticated;
