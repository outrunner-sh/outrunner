-- Composer attachments — files a user sends along with a prompt.
--
-- An attachment is uploaded before its workspace necessarily exists: the home
-- composer creates the workspace by sending, so the bytes have to be parked
-- somewhere first and pulled onto the box once it is running. That is why this
-- is owner-scoped storage rather than something written straight to the box.
--
-- Rows are deliberately short-lived: once materialized onto a box the file
-- lives in the worktree, and this row plus its object are only the transport.
-- ---------------------------------------------------------------------------

create table attachments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,

  -- Null until the attachment is sent: home-composer uploads happen before the
  -- workspace exists, and are bound to one when the prompt is sent.
  workspace_id uuid,

  -- The name the user's file had, for display and for the on-box filename.
  -- Sanitized on the way in (see lib/runtime/attachments.ts) — it becomes a
  -- path segment on the box.
  filename text not null,
  content_type text not null,
  size_bytes bigint not null,

  -- Object key inside the attachments bucket:
  -- `uploads/{owner_id}/{attachment_id}/{filename}`.
  storage_path text not null,

  -- Set once the file has been written into a workspace's worktree, so a
  -- re-send does not duplicate it.
  materialized_at timestamptz,

  created_at timestamptz not null default now(),

  constraint attachments_owner_id_unique unique (owner_id, id),
  constraint attachments_owner_workspace_fkey
    foreign key (owner_id, workspace_id)
    references workspaces (owner_id, id) on delete cascade
);

create index attachments_owner_created_idx
  on attachments (owner_id, created_at desc);
create index attachments_workspace_idx on attachments (workspace_id);

alter table attachments enable row level security;

create policy attachments_owner_all on attachments
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- ---------------------------------------------------------------------------
-- Object storage for the bytes themselves.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

-- Mirrors the snapshots bucket: bytes move through short-lived signed URLs
-- minted server-side, and this pins any direct authenticated access to the
-- owner's own namespace. Keys are `uploads/{owner_id}/{attachment_id}/{name}`,
-- so the first folder is 'uploads' and the second is the owner's uid.
create policy attachments_objects_owner_all on storage.objects
  for all to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = 'uploads'
    and (storage.foldername(name))[2] = (select auth.uid()::text)
  )
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = 'uploads'
    and (storage.foldername(name))[2] = (select auth.uid()::text)
  );
