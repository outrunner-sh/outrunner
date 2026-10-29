-- Media a session's agent uploads to show its work: screenshots and GIFs of
-- the change it made, embedded in its pull request (`![name](url)`).
--
-- Each file has a link that GitHub can show and that doesn't expire, under an
-- id nobody can guess (`public_id`, 32 random bytes), served by the app
-- (app/m/[file]/route.ts) from a private bucket. An image's link is public by
-- default; a video's is private (only its uploader, signed in, can open it)
-- unless uploaded as public. A link is a bearer link: its uploader can revoke
-- it and get a new one (a new public_id), and can delete the file. Nobody
-- else lists it.
--
-- An upload is a reservation first (`pending`), made under the org's caps,
-- then the box puts the bytes straight into storage with a signed upload URL
-- and the app checks them before the file is `ready` and its link works. A
-- box never holds a user's credentials for this: it signs with its own secret
-- (app/api/runtime/media).
-- ---------------------------------------------------------------------------

create table if not exists media (
  id uuid primary key default gen_random_uuid(),
  public_id text not null unique check (public_id ~ '^[A-Za-z0-9_-]{43}$'),
  org_id uuid not null references organizations (id) on delete cascade,
  -- Who uploaded it: the owner of the session whose agent did.
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- The session it came from; kept when the session goes, since a pull
  -- request may still show the file.
  workspace_id uuid references workspaces (id) on delete set null,
  name text not null check (char_length(name) between 1 and 200),
  content_type text not null
    check (content_type in ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 52428800),
  -- Who the link opens for: anyone ('public'), or its uploader alone.
  access text not null default 'public' check (access in ('public', 'private')),
  -- Object key in the media bucket: `{org_id}/{id}`.
  storage_path text not null,
  status text not null default 'pending' check (status in ('pending', 'ready')),
  created_at timestamptz not null default now(),
  ready_at timestamptz
);

create index if not exists media_org_created_idx on media (org_id, created_at desc);
create index if not exists media_owner_created_idx on media (owner_id, created_at desc);
create index if not exists media_workspace_idx on media (workspace_id, created_at desc)
  where workspace_id is not null;

alter table media enable row level security;

-- The uploader reads their own files; every write is the server's, with the
-- service role (lib/db/media.ts), so the caps can't be stepped around.
create policy media_owner_select on media
  for select to authenticated using ((select auth.uid()) = owner_id);
revoke all on table media from anon;
revoke insert, update, delete on table media from authenticated;
-- Said outright rather than left to the project's default privileges, which
-- newer Supabase projects no longer give a table.
grant select on table media to authenticated;
grant select, insert, update, delete on table media to service_role;

-- Reserve one upload for an org, or say why not: 'daily' when the org has
-- made `max_per_day` uploads in the last day, 'storage' when its files would
-- pass `max_bytes`. A pending upload counts against storage for 3 hours,
-- longer than its signed upload URL lasts (2 hours), and is swept after
-- (PENDING_UPLOAD_MS in lib/media/media.ts). Under a lock per org, so two boxes uploading at once
-- can't both slip under a cap. Null when the row was made.
create or replace function reserve_media_upload(
  media_id uuid,
  media_public_id text,
  media_org_id uuid,
  media_owner_id uuid,
  media_workspace_id uuid,
  media_name text,
  media_content_type text,
  media_size_bytes bigint,
  media_access text,
  media_storage_path text,
  max_per_day integer,
  max_bytes bigint
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtext('media_upload:' || media_org_id::text));

  if (
    select count(*) from media
    where org_id = media_org_id and created_at > now() - interval '1 day'
  ) >= max_per_day then
    return 'daily';
  end if;

  if (
    select coalesce(sum(size_bytes), 0) from media
    where org_id = media_org_id
      and (status = 'ready' or created_at > now() - interval '3 hours')
  ) + media_size_bytes > max_bytes then
    return 'storage';
  end if;

  insert into media (id, public_id, org_id, owner_id, workspace_id, name, content_type, size_bytes, access, storage_path)
  values (
    media_id, media_public_id, media_org_id, media_owner_id, media_workspace_id,
    media_name, media_content_type, media_size_bytes, media_access, media_storage_path
  );
  return null;
end;
$$;

revoke all on function reserve_media_upload(uuid, text, uuid, uuid, uuid, text, text, bigint, text, text, integer, bigint)
  from public, anon, authenticated;
grant execute on function reserve_media_upload(uuid, text, uuid, uuid, uuid, text, text, bigint, text, text, integer, bigint)
  to service_role;

-- The bytes. Private: the app serves them under the public id, and boxes
-- write them only through signed upload URLs it mints. The bucket's own
-- limits match the table's, so a signed URL can't be used for anything else.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media', 'media', false, 52428800,
  array['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
