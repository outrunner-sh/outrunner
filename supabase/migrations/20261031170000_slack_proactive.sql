-- The Slack agent speaks first: a digest in the channels that ask for one,
-- a nudge to whoever filed an item that waits in triage, follow-ups in an
-- item's thread (the validator's verdict, the merge), and, in channels that
-- opt in, an offer to file what looks like a bug report or request. All the
-- server's (RLS on, no policy, grants revoked), through lib/db/slack-channels.ts
-- and lib/db/slack-agent.ts.
-- ---------------------------------------------------------------------------

-- What the agent does in a channel, as someone with write on the org's
-- projects set it ("@Outrunner post a daily digest here at 9").
create table if not exists slack_channels (
  team_id text not null,
  channel_id text not null,
  org_id uuid not null references organizations (id) on delete cascade,
  -- Who set it: the digest shows what they may see.
  set_by uuid references auth.users (id) on delete set null,
  -- Offer to file what looks like a bug report or request, unmentioned.
  watch boolean not null default false,
  digest text check (digest in ('daily', 'weekly')),
  digest_hour integer not null default 9 check (digest_hour between 0 and 23),
  digest_tz text not null default 'UTC' check (char_length(digest_tz) between 1 and 64),
  -- The local date the last digest went out on: one a day (a week) at most.
  last_digest_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (team_id, channel_id)
);

drop trigger if exists slack_channels_set_updated_at on slack_channels;
create trigger slack_channels_set_updated_at
  before update on slack_channels
  for each row execute function set_updated_at();

-- The pull request of a thread's session, as the GitHub webhook saw it
-- open, and how far its follow-ups have got.
alter table slack_conversations add column if not exists pr_repo text;
alter table slack_conversations add column if not exists pr_number integer;
alter table slack_conversations add column if not exists pr_url text;
-- The validator comment last posted in the thread (GitHub's comment id).
alter table slack_conversations add column if not exists verdict_comment_id bigint;
alter table slack_conversations add column if not exists merged_announced boolean not null default false;
-- When its pull request was last checked: the tick takes the least recently
-- checked first, so every open one gets its turn.
alter table slack_conversations add column if not exists pr_checked_at timestamptz;

create index if not exists slack_conversations_pr_check_idx
  on slack_conversations (pr_checked_at nulls first) where pr_number is not null and not merged_announced;

-- When whoever filed an item waiting in triage was nudged about it: once.
alter table work_items add column if not exists slack_nudged_at timestamptz;
-- What already waits isn't news: only items that start waiting from now on
-- are nudged, rather than a burst of DMs about an old queue on the first tick.
update work_items set slack_nudged_at = now()
  where status = 'triage' and slack_nudged_at is null and created_at < now() - interval '1 day';

alter table slack_channels enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table slack_channels from anon, authenticated;
