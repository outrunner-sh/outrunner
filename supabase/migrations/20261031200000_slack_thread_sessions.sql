-- A Slack thread is its session (Replicas' way): the session started from a
-- thread knows it (a Slack badge in the sidebar, a link back), and the two
-- stay in step while sync is on: what's said in the thread goes to the
-- session, and the session's reply at the end of each turn goes to the
-- thread (lib/slack/relay.ts).
-- ---------------------------------------------------------------------------

alter table workspaces add column if not exists slack_thread_url text;
-- Thread and session in step; off, neither reaches the other.
alter table workspaces add column if not exists slack_sync boolean not null default true;

-- The session's last reply posted to the thread (a hash of it): each turn's
-- reply goes once.
alter table slack_conversations add column if not exists relayed_hash text;
-- Until when a reply is being waited for, after something was sent to the
-- session: the tick looks for it until then.
alter table slack_conversations add column if not exists relay_until timestamptz;

create index if not exists slack_conversations_relay_idx
  on slack_conversations (relay_until) where relay_until is not null;
