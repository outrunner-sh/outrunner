-- Seed-and-verify for 20261019120000_user_provider_keys.sql. Run against a
-- throwaway database that has the migrations before it applied:
--
--   1. psql -f supabase/verify/20261019120000_user_provider_keys.sql -v phase=seed
--   2. psql -f supabase/migrations/20261019120000_user_provider_keys.sql
--   3. psql -f supabase/verify/20261019120000_user_provider_keys.sql -v phase=between
--   4. psql -f supabase/migrations/20261019120000_user_provider_keys.sql   (again)
--   5. psql -f supabase/verify/20261019120000_user_provider_keys.sql -v phase=check
--
-- `between` is the deploy's window: what the old server and the new one save
-- after the first run and before the second.
--
-- Ciphertexts here are stand-ins: the migration copies them, never opens them.

\if :{?phase}
\else
  \echo 'set -v phase=seed, phase=between or phase=check'
  \quit
\endif

select (:'phase' = 'seed') as seeding, (:'phase' = 'between') as between \gset
\if :seeding

insert into auth.users (id) values
  ('00000000-0000-0000-0000-000000000001'), -- OpenRouter key only
  ('00000000-0000-0000-0000-000000000002'), -- Claude slot only (API key or token: SQL can't tell)
  ('00000000-0000-0000-0000-000000000003'), -- both
  ('00000000-0000-0000-0000-000000000004'), -- neither
  ('00000000-0000-0000-0000-000000000005'), -- OpenRouter key, replaced on the old server between runs
  ('00000000-0000-0000-0000-000000000006'), -- OpenRouter key, replaced on the new server between runs
  ('00000000-0000-0000-0000-000000000007'); -- OpenRouter key, removed on the new server between runs

insert into user_credentials (user_id, openrouter_key_ciphertext, openrouter_key_hint, openrouter_key_updated_at, anthropic_key_ciphertext, anthropic_key_hint) values
  ('00000000-0000-0000-0000-000000000001', 'or-sealed-1', 'aaa1', '2026-10-16T10:00:00Z', null, null),
  ('00000000-0000-0000-0000-000000000002', null, null, null, 'ant-sealed-2', 'bbb2'),
  ('00000000-0000-0000-0000-000000000003', 'or-sealed-3', 'ccc3', null, 'ant-sealed-3', 'ddd3'),
  ('00000000-0000-0000-0000-000000000004', null, null, null, null, null),
  ('00000000-0000-0000-0000-000000000005', 'or-sealed-old-5', 'eee5', '2026-10-16T10:00:00Z', null, null),
  ('00000000-0000-0000-0000-000000000006', 'or-sealed-old-6', 'ggg6', '2026-10-16T10:00:00Z', null, null),
  ('00000000-0000-0000-0000-000000000007', 'or-sealed-7', 'jjj7', '2026-10-16T10:00:00Z', null, null);

\elif :between

-- The old server replaces user 5's key, in the old columns.
update user_credentials
  set openrouter_key_ciphertext = 'or-sealed-new-5', openrouter_key_hint = 'fff5', openrouter_key_updated_at = now()
  where user_id = '00000000-0000-0000-0000-000000000005';
-- The new server replaces user 6's key, and user 3's (whose old key has no
-- saved time), in user_provider_keys.
update user_provider_keys set key_ciphertext = 'or-sealed-new-6', key_hint = 'hhh6'
  where user_id = '00000000-0000-0000-0000-000000000006';
update user_provider_keys set key_ciphertext = 'or-sealed-new-3', key_hint = 'iii3'
  where user_id = '00000000-0000-0000-0000-000000000003';
-- The new server removes user 7's key: its row, and the old columns
-- (clearProviderKey), so the second run has nothing to copy back.
delete from user_provider_keys where user_id = '00000000-0000-0000-0000-000000000007';
update user_credentials
  set openrouter_key_ciphertext = null, openrouter_key_hint = null, openrouter_key_updated_at = null
  where user_id = '00000000-0000-0000-0000-000000000007';

\else

do $$
declare
  n int;
begin
  -- One OpenRouter row per saved key, copied as it was.
  select count(*) into n from user_provider_keys;
  if n <> 4 then raise exception 'expected 4 provider keys, found %', n; end if;

  perform 1 from user_provider_keys
    where user_id = '00000000-0000-0000-0000-000000000001' and provider = 'openrouter'
      and key_ciphertext = 'or-sealed-1' and key_hint = 'aaa1' and updated_at = '2026-10-16T10:00:00Z';
  if not found then raise exception 'user 1: OpenRouter key not copied as it was'; end if;

  -- Replaced on the new server: kept, though the old key has no saved time.
  perform 1 from user_provider_keys
    where user_id = '00000000-0000-0000-0000-000000000003' and provider = 'openrouter' and key_ciphertext = 'or-sealed-new-3';
  if not found then raise exception 'user 3: the newer key was overwritten by one with no saved time'; end if;

  -- Replaced on the old server between runs: the second run copies it.
  perform 1 from user_provider_keys
    where user_id = '00000000-0000-0000-0000-000000000005' and provider = 'openrouter'
      and key_ciphertext = 'or-sealed-new-5' and key_hint = 'fff5';
  if not found then raise exception 'user 5: the replacement saved on the old server was not copied'; end if;

  -- Replaced on the new server between runs: the second run keeps it.
  perform 1 from user_provider_keys
    where user_id = '00000000-0000-0000-0000-000000000006' and provider = 'openrouter'
      and key_ciphertext = 'or-sealed-new-6' and key_hint = 'hhh6';
  if not found then raise exception 'user 6: the key saved on the new server was overwritten'; end if;

  -- Removed on the new server between runs: stays removed.
  perform 1 from user_provider_keys where user_id = '00000000-0000-0000-0000-000000000007';
  if found then raise exception 'user 7: a removed key came back'; end if;

  -- The Claude slot is the app's to move: SQL leaves it, and adds nothing for it.
  select count(*) into n from user_provider_keys where provider = 'anthropic';
  if n <> 0 then raise exception 'SQL moved % Claude-slot values', n; end if;
  select count(*) into n from user_credentials where anthropic_key_ciphertext is not null;
  if n <> 2 then raise exception 'Claude slot changed: % left', n; end if;

  -- The old columns stay until a later release.
  select count(*) into n from user_credentials where openrouter_key_ciphertext is not null;
  if n <> 4 then raise exception 'old OpenRouter columns changed: % left', n; end if;

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
