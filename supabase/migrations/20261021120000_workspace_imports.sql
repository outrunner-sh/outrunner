-- Sessions imported from someone's Mac (runtime-agent import): which session
-- became which workspace, so the picker can say one was imported already and
-- a second import is asked for, not made by accident.
--
-- One row per imported workspace; the workspace's own row and its Snapshot
-- are made with it. Destroying the workspace removes the row (the cascade),
-- and a destroyed one is not counted (lib/db/imports.ts), so the session can
-- come again.
-- ---------------------------------------------------------------------------

create table if not exists workspace_imports (
  owner_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null,
  -- "<agent>:<session id>", as the scan names it.
  session_key text not null check (session_key ~ '^(claude|codex):[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  source text not null check (source in ('conductor', 'claude-cli', 'codex-cli', 'outrunner-local')),
  -- The stored conversation's digest: which state of the session came.
  conversation_sha256 text not null check (conversation_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (owner_id, workspace_id),
  constraint workspace_imports_owner_workspace_fkey
    foreign key (owner_id, workspace_id)
    references workspaces (owner_id, id) on delete cascade
);

create index if not exists workspace_imports_owner_key
  on workspace_imports (owner_id, session_key);

alter table workspace_imports enable row level security;

drop policy if exists workspace_imports_owner_all on workspace_imports;
create policy workspace_imports_owner_all on workspace_imports
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- An imported session's history and conversation are uploaded straight from
-- the Mac, compressed; a long one runs to hundreds of MB. Say the bucket's
-- limit rather than inherit whatever the project's default is. The project's
-- own storage limit still caps it (Settings → Storage), and must be at least
-- this for an upload this large to land.
update storage.buckets set file_size_limit = 1073741824 where id = 'workspace-snapshots';
