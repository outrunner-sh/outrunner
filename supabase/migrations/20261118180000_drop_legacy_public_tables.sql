-- Removes the legacy app's tables: the 43 that came along in production's
-- public schema when the project moved to Mumbai. They belong to another app
-- (an Alembic-managed chat app with its own auth, user, api_key,
-- oauth_session and config), not to Outrunner. No migration creates them and
-- Outrunner never reads them. 20261104130000_lock_legacy_public_tables.sql
-- closed them to anon and authenticated, and this drops them.
--
-- TAKE A BACKUP FIRST. This deletes their data for good. Before applying,
-- dump the tables as supabase/README.md shows ("Dropping the legacy app's
-- tables") and check that the dump restores.
--
-- On every database but production's (fresh installs, local, CI) none of
-- these tables exists, and the migration does nothing.

-- Refuse to drop anything but these tables. `cascade` below is only for the
-- foreign keys between them (chat_message → chat, and so on). If a view,
-- foreign key, policy, trigger, column default, column type or function
-- outside the set depends on one of them, nothing is dropped and this names
-- what depends on them.
do $$
declare
  legacy oid[];
  dependents text;
begin
  select coalesce(array_agg(c.oid), '{}') into legacy
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname = any (array[
    'access_grant', 'alembic_version', 'api_key', 'auth', 'automation', 'automation_run',
    'calendar', 'calendar_event', 'calendar_event_attendee', 'channel', 'channel_file',
    'channel_member', 'channel_webhook', 'chat', 'chat_file', 'chat_message', 'chatidtag',
    'config', 'config_old', 'document', 'feedback', 'file', 'folder', 'function', 'group',
    'group_member', 'knowledge', 'knowledge_directory', 'knowledge_file', 'memory', 'message',
    'message_reaction', 'model', 'note', 'oauth_session', 'pinned_note', 'prompt',
    'prompt_history', 'shared_chat', 'skill', 'tag', 'tool', 'user'
  ])
  -- An Outrunner prompt_history is kept (see below), so it's outside the set.
  and not (c.relname = 'prompt_history' and (select count(*) from pg_attribute a
    where a.attrelid = c.oid and a.attname in ('owner_id', 'text') and not a.attisdropped) = 2);

  with referenced as (
    -- The tables, their row types (and arrays of them), and their sequences.
    select 'pg_class'::regclass as class, oid from pg_class where oid = any (legacy)
    union all
    select 'pg_type'::regclass, t.oid from pg_class c join pg_type t on t.oid in (c.reltype, (select typarray from pg_type where oid = c.reltype))
    where c.oid = any (legacy)
    union all
    select 'pg_class'::regclass, d.objid from pg_depend d join pg_class s on s.oid = d.objid and s.relkind = 'S'
    where d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass
      and d.refobjid = any (legacy) and d.deptype in ('a', 'i')
  )
  select string_agg(distinct pg_describe_object(d.classid, d.objid, d.objsubid), '; ') into dependents
  from pg_depend d join referenced r on r.class = d.refclassid and r.oid = d.refobjid
  where d.deptype = 'n'
    -- The relation each dependent belongs to; anything else (a function) is outside.
    and coalesce(case d.classid
      when 'pg_class'::regclass then d.objid
      when 'pg_rewrite'::regclass then (select ev_class from pg_rewrite where oid = d.objid)
      when 'pg_constraint'::regclass then (select conrelid from pg_constraint where oid = d.objid)
      when 'pg_trigger'::regclass then (select tgrelid from pg_trigger where oid = d.objid)
      when 'pg_policy'::regclass then (select polrelid from pg_policy where oid = d.objid)
      when 'pg_attrdef'::regclass then (select adrelid from pg_attrdef where oid = d.objid)
    end, 0) <> all (legacy);

  if dependents is not null then
    raise exception 'Not dropping the legacy tables: other objects depend on them: %', dependents
      using hint = 'Drop or move those first (after a backup), then apply this again.';
  end if;
end
$$;

drop table if exists public."access_grant" cascade;
drop table if exists public."alembic_version" cascade;
drop table if exists public."api_key" cascade;
drop table if exists public."auth" cascade;
drop table if exists public."automation" cascade;
drop table if exists public."automation_run" cascade;
drop table if exists public."calendar" cascade;
drop table if exists public."calendar_event" cascade;
drop table if exists public."calendar_event_attendee" cascade;
drop table if exists public."channel" cascade;
drop table if exists public."channel_file" cascade;
drop table if exists public."channel_member" cascade;
drop table if exists public."channel_webhook" cascade;
drop table if exists public."chat" cascade;
drop table if exists public."chat_file" cascade;
drop table if exists public."chat_message" cascade;
drop table if exists public."chatidtag" cascade;
drop table if exists public."config" cascade;
drop table if exists public."config_old" cascade;
drop table if exists public."document" cascade;
drop table if exists public."feedback" cascade;
drop table if exists public."file" cascade;
drop table if exists public."folder" cascade;
drop table if exists public."function" cascade;
drop table if exists public."group" cascade;
drop table if exists public."group_member" cascade;
drop table if exists public."knowledge" cascade;
drop table if exists public."knowledge_directory" cascade;
drop table if exists public."knowledge_file" cascade;
drop table if exists public."memory" cascade;
drop table if exists public."message" cascade;
drop table if exists public."message_reaction" cascade;
drop table if exists public."model" cascade;
drop table if exists public."note" cascade;
drop table if exists public."oauth_session" cascade;
drop table if exists public."pinned_note" cascade;
drop table if exists public."prompt" cascade;
-- Production's prompt_history is the legacy app's. A database that applied
-- 20261102230000 before its correction has Outrunner's earlier composer table
-- by that name (owner_id, text) instead, which 20261102270000 deliberately
-- keeps: keep it here too.
do $$
begin
  if (select count(*) from pg_attribute where attrelid = to_regclass('public.prompt_history')
      and attname in ('owner_id', 'text') and not attisdropped) < 2 then
    drop table if exists public."prompt_history" cascade;
  end if;
end
$$;
drop table if exists public."shared_chat" cascade;
drop table if exists public."skill" cascade;
drop table if exists public."tag" cascade;
drop table if exists public."tool" cascade;
drop table if exists public."user" cascade;
