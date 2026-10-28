-- Orgs, step thirteen: the audit log (Settings → Org → Audit log). Each
-- admin change to an org, and each that Outrunner makes itself (a plan
-- changing in Stripe, the GitHub App uninstalled on GitHub), recorded once:
-- who, what, to which thing, and its details, never a secret
-- (lib/audit/record.ts).
--
-- Append-only: no one changes an event once recorded, the server included;
-- an event goes only with its org. Read by the org's admins through the
-- server (service role), like its other admin tables.
-- ---------------------------------------------------------------------------

create table if not exists audit_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations (id) on delete cascade,
  -- A person (actor_id their user), or Outrunner itself.
  actor_type text not null check (actor_type in ('user', 'system')),
  -- No reference to the user: one would change the event when they go, which
  -- the log refuses (and so refuse their going). actor_label says who.
  actor_id uuid,
  -- Who they were at the time: a login outlives the account.
  actor_label text not null check (char_length(actor_label) between 1 and 200),
  -- e.g. member.invited, key.saved (lib/audit/actions.ts).
  action text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  resource_type text check (char_length(resource_type) <= 50),
  resource_id text check (char_length(resource_id) <= 200),
  resource_label text check (char_length(resource_label) <= 300),
  details jsonb not null default '{}' check (pg_column_size(details) <= 8192),
  created_at timestamptz not null default now()
);

create index if not exists audit_events_org_created_idx on audit_events (org_id, id desc);

-- Recorded once: an update is refused whoever asks. (A delete is only ever
-- the org's own going, by its cascade.)
create or replace function audit_events_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'an audit event is never changed' using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists audit_events_append_only on audit_events;
create trigger audit_events_append_only
  before update on audit_events
  for each row execute function audit_events_append_only();

alter table audit_events enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table audit_events from anon, authenticated;
