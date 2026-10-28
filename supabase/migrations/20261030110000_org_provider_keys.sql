-- Orgs, step eight: an org's keys for model providers (Settings → Org →
-- Keys), set by its admins for its members' cloud sessions. A member's own
-- key for a provider always wins over the org's (lib/db/credentials.ts).
--
-- A team org's only: a personal org's keys are its owner's own
-- (user_provider_keys).
--
-- Third-party credentials, so the same treatment as user_provider_keys: RLS
-- on with no policy and every grant revoked, reached only by the service role.
-- Keys are AES-256-GCM sealed (lib/crypto/secret-box.ts).
-- ---------------------------------------------------------------------------

create table if not exists org_provider_keys (
  org_id uuid not null references organizations (id) on delete cascade,
  -- An id from runtime-agent/internal/claude/providers.json, or openai.
  provider text not null check (provider ~ '^[a-z][a-z0-9-]{1,31}$'),
  -- The key, sealed.
  key_ciphertext text not null,
  -- Its last 4 characters, for display without decrypting.
  key_hint text,
  -- The admin who saved it.
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, provider)
);

drop trigger if exists org_provider_keys_set_updated_at on org_provider_keys;
create trigger org_provider_keys_set_updated_at
  before update on org_provider_keys
  for each row execute function set_updated_at();

create or replace function org_provider_keys_team_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (select 1 from organizations where id = new.org_id and personal_owner_id is not null) then
    raise exception 'a personal org has no keys of its own' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists org_provider_keys_team_only on org_provider_keys;
create trigger org_provider_keys_team_only
  before insert or update on org_provider_keys
  for each row execute function org_provider_keys_team_only();

alter table org_provider_keys enable row level security;
-- No policy, on purpose: see 20260928120000_user_credentials.sql.
revoke all on table org_provider_keys from anon, authenticated;
