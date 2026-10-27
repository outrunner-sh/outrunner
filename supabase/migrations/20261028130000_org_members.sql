-- Orgs, step three: members. An admin invites someone by email; someone whose
-- email's domain an org has claimed asks to join it, and an admin approves.
-- An admin removes a member, or a member leaves: they lose the org at once,
-- their sessions in it are stopped, and after 30 days deleted.
--
-- Every table here is the server's alone (RLS on, no policy, grants revoked),
-- reached through lib/db/org-members.ts, which checks who may. The changes to
-- who is in an org go through the functions at the end, one transaction each,
-- so an org is never left without an admin.
-- ---------------------------------------------------------------------------

create table if not exists organization_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role text not null check (role in ('admin', 'member')),
  -- sha256 of the link's token, as cli_tokens keeps them: a leaked row lets
  -- no one in.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz
);

-- One open invite per email per org: inviting again replaces it.
create unique index if not exists organization_invites_one_open
  on organization_invites (org_id, email) where accepted_at is null and revoked_at is null;
create index if not exists organization_invites_email_idx on organization_invites (email);

alter table organization_invites enable row level security;
revoke all on table organization_invites from anon, authenticated;

create table if not exists organization_join_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The email whose domain matched, as the admins are shown it.
  email text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz
);

create unique index if not exists organization_join_requests_one_pending
  on organization_join_requests (org_id, user_id) where status = 'pending';

alter table organization_join_requests enable row level security;
revoke all on table organization_join_requests from anon, authenticated;

-- Who left an org, or was removed, and when: their sessions in it are
-- stopped, and deleted 30 days on (the reconciler's cron). Coming back
-- (an invite, an approved request) takes the row away, and with it the clock.
create table if not exists organization_removals (
  org_id uuid not null references organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  removed_by uuid references auth.users (id) on delete set null,
  removed_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

alter table organization_removals enable row level security;
revoke all on table organization_removals from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Changing who is in an org. For the server alone; each raises an exception
-- whose message is a word the app reads (lib/db/org-members.ts).
-- ---------------------------------------------------------------------------

-- Add a member (or keep one: an existing member's role stays), and stop the
-- clock on their sessions if they were removed before.
create or replace function add_org_member(target_org uuid, member uuid, member_role text)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  insert into organization_members (org_id, user_id, role)
  values (target_org, member, member_role)
  on conflict (org_id, user_id) do nothing;
  delete from organization_removals where org_id = target_org and user_id = member;
end;
$$;

-- Accept an invite, by its token's hash, as `member`. The server has checked
-- the invite's email is one of theirs. The org's id.
create or replace function accept_org_invite(invite_token_hash text, member uuid)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  invite organization_invites%rowtype;
begin
  select * into invite from organization_invites where token_hash = invite_token_hash for update;
  if not found or invite.revoked_at is not null or invite.accepted_at is not null
     or invite.expires_at <= now() then
    raise exception 'invite_invalid';
  end if;
  perform add_org_member(invite.org_id, member, invite.role);
  update organization_invites set accepted_at = now(), accepted_by = member where id = invite.id;
  return invite.org_id;
end;
$$;

-- Approve a pending request to join, adding its asker as `member_role`.
create or replace function approve_join_request(request uuid, decider uuid, member_role text)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  asked organization_join_requests%rowtype;
begin
  select * into asked from organization_join_requests where id = request for update;
  if not found or asked.status <> 'pending' then
    raise exception 'request_not_pending';
  end if;
  perform add_org_member(asked.org_id, asked.user_id, member_role);
  update organization_join_requests
  set status = 'approved', decided_by = decider, decided_at = now()
  where id = request;
  return asked.user_id;
end;
$$;

-- Whether taking `member`'s admin role away would leave the team org with
-- none. Takes the org's row lock, so two at once can't each leave the other.
create or replace function would_orphan_org(target_org uuid, member uuid)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  perform 1 from organizations where id = target_org for update;
  return exists (
    select 1 from organization_members where org_id = target_org and user_id = member and role = 'admin'
  ) and not exists (
    select 1 from organization_members where org_id = target_org and user_id <> member and role = 'admin'
  );
end;
$$;

-- Take `member` out of a team org (remover = member: they left). Never the
-- last admin, and never anyone out of a personal org.
create or replace function remove_org_member(target_org uuid, member uuid, remover uuid)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from organizations where id = target_org and personal_owner_id is not null) then
    raise exception 'personal_org';
  end if;
  if would_orphan_org(target_org, member) then
    raise exception 'last_admin';
  end if;
  delete from organization_members where org_id = target_org and user_id = member;
  if not found then
    raise exception 'not_a_member';
  end if;
  insert into organization_removals (org_id, user_id, removed_by)
  values (target_org, member, remover)
  on conflict (org_id, user_id) do update set removed_by = excluded.removed_by, removed_at = now();
end;
$$;

-- Make a member an admin or a member. Never the last admin a member.
create or replace function set_org_member_role(target_org uuid, member uuid, member_role text)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from organizations where id = target_org and personal_owner_id is not null) then
    raise exception 'personal_org';
  end if;
  if member_role = 'member' and would_orphan_org(target_org, member) then
    raise exception 'last_admin';
  end if;
  update organization_members set role = member_role where org_id = target_org and user_id = member;
  if not found then
    raise exception 'not_a_member';
  end if;
end;
$$;

revoke all on function add_org_member(uuid, uuid, text) from public, anon, authenticated;
revoke all on function accept_org_invite(text, uuid) from public, anon, authenticated;
revoke all on function approve_join_request(uuid, uuid, text) from public, anon, authenticated;
revoke all on function would_orphan_org(uuid, uuid) from public, anon, authenticated;
revoke all on function remove_org_member(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function set_org_member_role(uuid, uuid, text) from public, anon, authenticated;
grant execute on function add_org_member(uuid, uuid, text) to service_role;
grant execute on function accept_org_invite(text, uuid) to service_role;
grant execute on function approve_join_request(uuid, uuid, text) to service_role;
grant execute on function would_orphan_org(uuid, uuid) to service_role;
grant execute on function remove_org_member(uuid, uuid, uuid) to service_role;
grant execute on function set_org_member_role(uuid, uuid, text) to service_role;
