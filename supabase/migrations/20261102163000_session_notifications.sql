-- Notifications when a session's turn finishes, it needs your input or
-- errors, and when its pull request opens or merges (lib/notifications).
-- Each is recorded once, by what it is about (event_key), so a watch and a
-- tick seeing the same thing tell you once; the browser, email
-- and Slack deliver from these rows.
-- ---------------------------------------------------------------------------

create table if not exists session_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null references workspaces (id) on delete cascade,
  kind text not null check (kind in ('turn_done', 'needs_input', 'errored', 'pr_opened', 'pr_merged')),
  -- What the event is (a reply's time, a question's call, a pull request's
  -- number): the same event is never recorded twice.
  event_key text not null,
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  -- Handled for email and for Slack (sent, or let go of as seen or turned off).
  emailed_at timestamptz,
  slacked_at timestamptz,
  constraint session_notifications_once unique (user_id, workspace_id, kind, event_key)
);

create index if not exists session_notifications_user_idx
  on session_notifications (user_id, created_at desc);
create index if not exists session_notifications_email_idx
  on session_notifications (created_at) where emailed_at is null;
create index if not exists session_notifications_slack_idx
  on session_notifications (created_at) where slacked_at is null;

alter table session_notifications enable row level security;

drop policy if exists session_notifications_own_read on session_notifications;
create policy session_notifications_own_read on session_notifications
  for select using (auth.uid() = user_id);

-- How each person wants to hear: in the browser (on unless
-- turned off), by email (off, each one, or a daily digest), by Slack DM
-- (off unless turned on, and only with their Slack linked), and which events.
create table if not exists notification_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  browser boolean not null default true,
  email text not null default 'off' check (email in ('off', 'instant', 'digest')),
  slack boolean not null default false,
  kinds text[] not null default '{turn_done,needs_input,errored,pr_opened,pr_merged}'
    check (kinds <@ array['turn_done', 'needs_input', 'errored', 'pr_opened', 'pr_merged']),
  digest_sent_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table notification_preferences enable row level security;

drop policy if exists notification_preferences_own on notification_preferences;
create policy notification_preferences_own on notification_preferences
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- When a session last failed: set as its status turns failed, and by nothing
-- else, so a later write to a failed session (a rename, an archive) isn't
-- told as a new failure, as updated_at would be.
alter table workspaces add column if not exists failed_at timestamptz;

create or replace function workspaces_mark_failed()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.status = 'failed' and (tg_op = 'INSERT' or old.status is distinct from 'failed') then
    new.failed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists workspaces_mark_failed on workspaces;
create trigger workspaces_mark_failed
  before insert or update of status on workspaces
  for each row execute function workspaces_mark_failed();

create index if not exists workspaces_failed_at_idx
  on workspaces (failed_at) where status = 'failed';
