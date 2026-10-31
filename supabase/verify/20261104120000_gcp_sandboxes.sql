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
