-- Seed-and-verify for 20261019120000_user_provider_keys.sql. Run against a
-- throwaway database that has the migrations before it applied:
--
--   1. psql -f supabase/verify/20261019120000_user_provider_keys.sql -v phase=seed
--   2. psql -f supabase/migrations/20261019120000_user_provider_keys.sql   (twice)
--   3. psql -f supabase/verify/20261019120000_user_provider_keys.sql -v phase=check
--
-- Ciphertexts here are stand-ins: the migration copies them, never opens them.

\if :{?phase}
\else
  \echo 'set -v phase=seed or -v phase=check'
  \quit
\endif

select (:'phase' = 'seed') as seeding \gset
\if :seeding

insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000001'), -- OpenRouter key only
  ('00000000-0000-0000-0000-000000000002'), -- Claude slot only (API key or token: SQL can't tell)
  ('00000000-0000-0000-0000-000000000003'), -- both
  ('00000000-0000-0000-0000-000000000004'), -- neither
  ('00000000-0000-0000-0000-000000000005'); -- OpenRouter key, and a newer one saved since

insert into user_credentials (user_id, openrouter_key_ciphertext, openrouter_key_hint, openrouter_key_updated_at, anthropic_key_ciphertext, anthropic_key_hint) values
  ('00000000-0000-0000-0000-000000000001', 'or-sealed-1', 'aaa1', '2026-10-16T10:00:00Z', null, null),
  ('00000000-0000-0000-0000-000000000002', null, null, null, 'ant-sealed-2', 'bbb2'),
  ('00000000-0000-0000-0000-000000000003', 'or-sealed-3', 'ccc3', null, 'ant-sealed-3', 'ddd3'),
  ('00000000-0000-0000-0000-000000000004', null, null, null, null, null),
  ('00000000-0000-0000-0000-000000000005', 'or-sealed-old-5', 'eee5', '2026-10-16T10:00:00Z', null, null);

\else

do $$
declare
  n int;
begin
  -- One OpenRouter row per saved key, copied as it was.
  select count(*) into n from user_provider_keys;
  if n <> 3 then raise exception 'expected 3 provider keys, found %', n; end if;

  perform 1 from user_provider_keys
    where user_id = '00000000-0000-0000-0000-000000000001' and provider = 'openrouter'
      and key_ciphertext = 'or-sealed-1' and key_hint = 'aaa1' and updated_at = '2026-10-16T10:00:00Z';
  if not found then raise exception 'user 1: OpenRouter key not copied as it was'; end if;

  perform 1 from user_provider_keys
    where user_id = '00000000-0000-0000-0000-000000000003' and provider = 'openrouter' and key_ciphertext = 'or-sealed-3';
  if not found then raise exception 'user 3: OpenRouter key not copied'; end if;

  -- A key saved since (here, before a second run) is newer, and kept.
  perform 1 from user_provider_keys
    where user_id = '00000000-0000-0000-0000-000000000005' and provider = 'openrouter' and key_ciphertext = 'or-sealed-new-5';
  if not found then raise exception 'user 5: the newer key was overwritten'; end if;

  -- The Claude slot is the app's to move: SQL leaves it, and adds nothing for it.
  select count(*) into n from user_provider_keys where provider = 'anthropic';
  if n <> 0 then raise exception 'SQL moved % Claude-slot values', n; end if;
  select count(*) into n from user_credentials where anthropic_key_ciphertext is not null;
  if n <> 2 then raise exception 'Claude slot changed: % left', n; end if;

  -- The old columns stay until a later release.
  select count(*) into n from user_credentials where openrouter_key_ciphertext is not null;
  if n <> 3 then raise exception 'old OpenRouter columns changed: % left', n; end if;

  -- Only the service role reaches the table.
  if has_table_privilege('anon', 'user_provider_keys', 'select')
     or has_table_privilege('authenticated', 'user_provider_keys', 'select') then
    raise exception 'anon or authenticated can read user_provider_keys';
  end if;
  if not (select relrowsecurity from pg_class where relname = 'user_provider_keys') then
    raise exception 'RLS is off on user_provider_keys';
  end if;

  -- A provider id that isn't one is refused.
  begin
    insert into user_provider_keys (user_id, provider, key_ciphertext)
      values ('00000000-0000-0000-0000-000000000004', 'Not A Provider', 'x');
    raise exception 'a bad provider id was stored';
  exception when check_violation then null;
  end;

  -- Deleting a user deletes their keys.
  delete from auth.users where id = '00000000-0000-0000-0000-000000000001';
  select count(*) into n from user_provider_keys where user_id = '00000000-0000-0000-0000-000000000001';
  if n <> 0 then raise exception 'a deleted user''s keys remain'; end if;

  raise notice 'user_provider_keys: all checks passed';
end $$;

\endif
