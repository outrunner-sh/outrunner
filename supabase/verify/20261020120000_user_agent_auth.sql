-- Verify 20261020120000_user_agent_auth.sql. Run against a throwaway database
-- with the migrations up to it applied:
--
--   psql -f supabase/verify/20261020120000_user_agent_auth.sql

do $$
declare
  n int;
begin
  insert into auth.users (id) values ('00000000-0000-0000-0000-0000000000a1');

  -- One pick per agent; picking again replaces it.
  insert into user_agent_auth (user_id, agent, method) values
    ('00000000-0000-0000-0000-0000000000a1', 'claude', 'subscription'),
    ('00000000-0000-0000-0000-0000000000a1', 'codex', 'chatgpt');
  insert into user_agent_auth (user_id, agent, method)
    values ('00000000-0000-0000-0000-0000000000a1', 'codex', 'api-key')
    on conflict (user_id, agent) do update set method = excluded.method;
  select count(*) into n from user_agent_auth where user_id = '00000000-0000-0000-0000-0000000000a1';
  if n <> 2 then raise exception 'expected 2 picks, found %', n; end if;
  perform 1 from user_agent_auth
    where user_id = '00000000-0000-0000-0000-0000000000a1' and agent = 'codex' and method = 'api-key';
  if not found then raise exception 'a second pick did not replace the first'; end if;

  -- No agent or way there isn't.
  begin
    insert into user_agent_auth (user_id, agent, method)
      values ('00000000-0000-0000-0000-0000000000a1', 'cursor', 'api-key');
    raise exception 'an unknown agent was stored';
  exception when check_violation then null;
  end;
  begin
    update user_agent_auth set method = 'password'
      where user_id = '00000000-0000-0000-0000-0000000000a1' and agent = 'claude';
    raise exception 'an unknown way of signing in was stored';
  exception when check_violation then null;
  end;

  -- Only the service role reaches the table.
  if has_table_privilege('anon', 'user_agent_auth', 'select')
     or has_table_privilege('authenticated', 'user_agent_auth', 'select') then
    raise exception 'anon or authenticated can read user_agent_auth';
  end if;
  if not (select relrowsecurity from pg_class where relname = 'user_agent_auth') then
    raise exception 'RLS is off on user_agent_auth';
  end if;

  -- Deleting a user deletes their picks.
  delete from auth.users where id = '00000000-0000-0000-0000-0000000000a1';
  select count(*) into n from user_agent_auth where user_id = '00000000-0000-0000-0000-0000000000a1';
  if n <> 0 then raise exception 'a deleted user''s picks remain'; end if;

  raise notice 'user_agent_auth: all checks passed';
end $$;
