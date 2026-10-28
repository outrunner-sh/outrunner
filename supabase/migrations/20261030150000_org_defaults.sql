-- Orgs, step nine: an org's defaults for its members' new sessions
-- (Settings → Org → Defaults), set by its admins: the model a session
-- starts on, and the size of a new box. A member's own choice always wins
-- (Settings → Default models, Settings → Sandbox); the org's is for members
-- who haven't made one, and Outrunner's own for the rest.
--
-- A team org's only, like its keys (20261030110000_org_provider_keys.sql).
-- Not secret, but the server's alone all the same: lib/db/org-defaults.ts.
-- ---------------------------------------------------------------------------

create table if not exists organization_settings (
  org_id uuid primary key references organizations (id) on delete cascade,
  -- A model choice as a loadout entry keeps it: {provider, id, effort?}.
  default_model jsonb,
  box_size text check (box_size in ('x-small', 'small', 'medium', 'large')),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

drop trigger if exists organization_settings_set_updated_at on organization_settings;
create trigger organization_settings_set_updated_at
  before update on organization_settings
  for each row execute function set_updated_at();

create or replace function organization_settings_team_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (select 1 from organizations where id = new.org_id and personal_owner_id is not null) then
    raise exception 'a personal org''s defaults are its owner''s own' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists organization_settings_team_only on organization_settings;
create trigger organization_settings_team_only
  before insert or update on organization_settings
  for each row execute function organization_settings_team_only();

alter table organization_settings enable row level security;
revoke all on table organization_settings from anon, authenticated;

-- Whether a user chose their box size (Settings → Sandbox), or has the one
-- every user started with: only then is their org's theirs. One already
-- other than that was chosen.
alter table user_credentials
  add column if not exists box_size_chosen boolean not null default false;
update user_credentials set box_size_chosen = true where box_size <> 'small' and not box_size_chosen;
