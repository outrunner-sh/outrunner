-- Tables in production's public schema that no Outrunner migration made
-- (another app's: an Alembic-managed chat app, with its own auth, user,
-- api_key, oauth_session and config tables) were left with row level
-- security off and the default grants, so anyone with the anon key the
-- browser bundle ships could read and write them through PostgREST.
--
-- Outrunner never reads them (public.prompt_history among them; see
-- 20261102230000_prompt_history.sql). Each is closed to the API's roles:
-- RLS on with no policies, and anon's and authenticated's privileges
-- revoked. The table owner, and so an app connecting as it, is unaffected
-- (RLS isn't forced), and service_role keeps its access. Tables absent from
-- a database (every one but production's) are skipped.

do $$
declare
  t text;
begin
  foreach t in array array[
    'access_grant', 'alembic_version', 'api_key', 'auth', 'automation', 'automation_run',
    'calendar', 'calendar_event', 'calendar_event_attendee', 'channel', 'channel_file',
    'channel_member', 'channel_webhook', 'chat', 'chat_file', 'chat_message', 'chatidtag',
    'config', 'config_old', 'document', 'feedback', 'file', 'folder', 'function', 'group',
    'group_member', 'knowledge', 'knowledge_directory', 'knowledge_file', 'memory', 'message',
    'message_reaction', 'model', 'note', 'oauth_session', 'pinned_note', 'prompt',
    'prompt_history', 'shared_chat', 'skill', 'tag', 'tool', 'user'
  ] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('revoke all on table public.%I from anon, authenticated', t);
    end if;
  end loop;
end
$$;
