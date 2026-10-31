-- Run after all migrations, in the throwaway verification database.
begin;
insert into auth.users(id) values ('00000000-0000-4000-a000-000000000011'), ('00000000-0000-4000-a000-000000000012');
insert into gcp_connections(id,user_id,project_id,project_number,zone,state) values
 ('00000000-0000-4000-a000-000000000021','00000000-0000-4000-a000-000000000011','sandbox-project','123456789','us-central1-a','connected');
select select_gcp_connection('00000000-0000-4000-a000-000000000011','00000000-0000-4000-a000-000000000021','small');
insert into gcp_resources(id,user_id,connection_id,instance_name) values
 ('00000000-0000-4000-a000-000000000031','00000000-0000-4000-a000-000000000011','00000000-0000-4000-a000-000000000021','outrunner-test');
do $$ begin
  if has_table_privilege('authenticated','gcp_connections','select') or has_table_privilege('anon','gcp_resources','select') then raise exception 'GCP tables exposed'; end if;
  if has_function_privilege('authenticated','select_gcp_connection(uuid,uuid,text)','execute') then raise exception 'GCP selection RPC exposed'; end if;
  begin
    perform disconnect_gcp_connection('00000000-0000-4000-a000-000000000011','00000000-0000-4000-a000-000000000021');
    raise exception 'Disconnected a live resource';
  exception when raise_exception then if sqlerrm not like 'Delete this connection%' then raise; end if; end;
  begin
    insert into gcp_resources(id,user_id,connection_id,instance_name) values ('00000000-0000-4000-a000-000000000032','00000000-0000-4000-a000-000000000012','00000000-0000-4000-a000-000000000021','other-owner');
    raise exception 'Cross-owner resource accepted';
  exception when raise_exception then if sqlerrm <> 'Google Cloud connection is unavailable' then raise; end if; end;
end $$;
update gcp_resources set state = 'deleted';
select disconnect_gcp_connection('00000000-0000-4000-a000-000000000011','00000000-0000-4000-a000-000000000021');
do $$ begin
  if (select sandbox from user_credentials where user_id = '00000000-0000-4000-a000-000000000011') <> 'outrunner' then raise exception 'Default did not reset'; end if;
  begin
    insert into gcp_resources(id,user_id,connection_id,instance_name) values ('00000000-0000-4000-a000-000000000033','00000000-0000-4000-a000-000000000011','00000000-0000-4000-a000-000000000021','revoked');
    raise exception 'Revoked connection accepted a resource';
  exception when raise_exception then if sqlerrm <> 'Google Cloud connection is unavailable' then raise; end if; end;
end $$;
rollback;

-- Failed deletes leave their rows unchanged. More than the old 20-row batch
-- must still rotate through every abandoned resource, including newer ones.
begin;
insert into auth.users(id) values ('00000000-0000-4000-a000-000000000011');
insert into gcp_connections(id,user_id,project_id,project_number,zone,state) values
 ('00000000-0000-4000-a000-000000000021','00000000-0000-4000-a000-000000000011','sandbox-project','123456789','us-central1-a','connected');
insert into gcp_resources(id,user_id,connection_id,instance_name,created_at)
select gen_random_uuid(), '00000000-0000-4000-a000-000000000011', '00000000-0000-4000-a000-000000000021',
  'cleanup-' || n, now() - interval '4 hours' + n * interval '1 minute'
from generate_series(1,25) n;
do $$
declare claimed integer; retried uuid;
begin
  if has_function_privilege('authenticated','gcp_cleanup_candidates(timestamptz)','execute') then
    raise exception 'GCP cleanup RPC exposed';
  end if;
  select count(*) into claimed from gcp_cleanup_candidates(now() - interval '2 hours');
  if claimed <> 10 then raise exception 'First cleanup batch was not bounded: %', claimed; end if;
  select count(*) into claimed from gcp_cleanup_candidates(now() - interval '2 hours');
  if claimed <> 10 then raise exception 'Failed oldest resources blocked the second batch: %', claimed; end if;
  select count(*) into claimed from gcp_cleanup_candidates(now() - interval '2 hours');
  if claimed <> 5 then raise exception 'Failed oldest resources starved newer resources: %', claimed; end if;
  if exists (select 1 from gcp_resources where cleanup_attempted_at is null) then
    raise exception 'A cleanup candidate was never attempted';
  end if;
  if exists (select 1 from gcp_cleanup_candidates(now() - interval '2 hours')) then
    raise exception 'Cleanup cooldown did not prevent immediate retries';
  end if;
  select id into retried from gcp_resources order by created_at limit 1;
  update gcp_resources set cleanup_attempted_at = now() - interval '6 minutes' where id = retried;
  select count(*) into claimed from gcp_cleanup_candidates(now() - interval '2 hours') where id = retried;
  if claimed <> 1 then raise exception 'Failed resources were not retried after cooldown'; end if;
end $$;
rollback;
