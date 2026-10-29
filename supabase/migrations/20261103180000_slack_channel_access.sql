-- Explicit, revocable read delegation. Existing installs/settings grant nothing.
alter table slack_channels add column shared_by uuid references auth.users(id) on delete set null;
alter table slack_channels add column shared_projects uuid[] not null default '{}';
alter table slack_channels add column shared_revision uuid;

-- A channel cannot silently switch orgs (including through digest/watch settings).
create function slack_channel_org_immutable() returns trigger language plpgsql as $$
begin
  if new.org_id <> old.org_id then
    raise exception 'This Slack channel is already configured for another organization';
  end if;
  return new;
end;
$$;
create trigger slack_channel_org_immutable before update on slack_channels
  for each row execute function slack_channel_org_immutable();

create function set_slack_channel_access(target_team text, target_channel text, target_org uuid,
  admin_id uuid, project_ids uuid[], slack_user_id text) returns void
language plpgsql security definer set search_path = public as $$
declare revision uuid;
begin
  -- Serialize grants against membership removal/demotion.
  perform 1 from organization_members where org_id = target_org and user_id = admin_id and role = 'admin' for share;
  if not found then
    raise exception 'Only an organization admin can share channel access';
  end if;
  -- Empty revokes. Every supplied project must currently belong to this org.
  if exists (select 1 from unnest(project_ids) pid where not exists
    (select 1 from projects where id = pid and org_id = target_org)) then
    raise exception 'A repository is not in this organization';
  end if;
  insert into slack_channels (team_id, channel_id, org_id, shared_by, shared_projects, shared_revision)
    values (target_team, target_channel, target_org,
      case when cardinality(project_ids) > 0 then admin_id end, project_ids,
      case when cardinality(project_ids) > 0 then gen_random_uuid() end)
    on conflict (team_id, channel_id) do update set
      shared_by = excluded.shared_by, shared_projects = excluded.shared_projects,
      shared_revision = excluded.shared_revision
    where slack_channels.org_id = target_org
    returning shared_revision into revision;
  if not found then raise exception 'This Slack channel is already configured for another organization'; end if;
  insert into audit_events (org_id, actor_type, actor_label, action, resource_type, resource_id, resource_label, details)
    values (target_org, 'system', 'Slack ' || target_team || '/' || slack_user_id,
      case when cardinality(project_ids) > 0 then 'slack_channel.shared' else 'slack_channel.revoked' end,
      'slack_channel', target_team || '/' || target_channel, target_channel,
      jsonb_build_object('slack_team_id', target_team, 'slack_channel_id', target_channel, 'slack_user_id', slack_user_id,
        'authorized_by', admin_id, 'revision', revision, 'project_ids', project_ids));
end;
$$;
revoke all on function set_slack_channel_access(text, text, uuid, uuid, uuid[], text) from public, anon, authenticated;
grant execute on function set_slack_channel_access(text, text, uuid, uuid, uuid[], text) to service_role;

-- Demotion/removal revokes permanently, even if the person rejoins later.
create function revoke_slack_channel_admin_access() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin') then
    update slack_channels set shared_by = null, shared_projects = '{}', shared_revision = null
      where org_id = old.org_id and shared_by = old.user_id;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger revoke_slack_channel_admin_access after delete or update of role on organization_members
  for each row execute function revoke_slack_channel_admin_access();
