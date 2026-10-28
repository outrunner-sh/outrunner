-- The Slack agent's research: a question about the code itself goes to a
-- session of the thread's own, in the background. It has the repository and
-- answers back through a one-time link (app/api/integrations/slack/research),
-- sleeps when the thread goes quiet, and is woken by the thread's next
-- question, with what it already knows. One per thread: threads never share
-- what they asked, and each sees only what its asker may read.
-- ---------------------------------------------------------------------------

-- A session the server runs out of sight (a thread's research): left out of
-- the sidebar and the session lists.
alter table workspaces add column if not exists background boolean not null default false;

alter table slack_conversations
  add column if not exists research_workspace_id uuid references workspaces (id) on delete set null;

-- One question put to a thread's research session, and the link it answers
-- through: the sha256 of a token only that prompt carried, good for one
-- answer.
create table if not exists slack_research (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references slack_conversations (id) on delete cascade,
  workspace_id uuid references workspaces (id) on delete set null,
  asked_by uuid references auth.users (id) on delete set null,
  question text not null check (char_length(question) between 1 and 20000),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'asked' check (status in ('asked', 'answered', 'failed')),
  created_at timestamptz not null default now(),
  answered_at timestamptz
);

create index if not exists slack_research_conversation_idx on slack_research (conversation_id, created_at desc);

alter table slack_research enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table slack_research from anon, authenticated;
