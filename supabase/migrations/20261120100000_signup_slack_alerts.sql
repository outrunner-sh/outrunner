-- ---------------------------------------------------------------------------
-- A Slack message for every new user, the first time they finish signing in:
-- by GitHub, Google, an email code or the desktop app alike, since each ends
-- in auth.users. Not on the row's insert: an email code makes the row when the
-- code is sent, so a typo or a code never used would be announced too.
--
-- Where it posts is a Slack incoming webhook, kept in Supabase Vault (never in
-- the repo), under the name signup_slack_webhook_url:
--
--   select vault.create_secret('https://hooks.slack.com/services/…', 'signup_slack_webhook_url');
--
-- Without it, nothing is sent. pg_net queues the request and sends it after
-- the sign-in's transaction commits, so Slack is never waited on, and any
-- failure here is a warning in the database log, never a failed sign-in.
-- ---------------------------------------------------------------------------

create extension if not exists pg_net with schema extensions;

-- SECURITY DEFINER: it runs on auth.users' writes, as Supabase Auth, which
-- can read neither the vault nor pg_net.
create or replace function announce_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  hook text;
  who text;
  display_name text;
begin
  -- The first sign-in only: a later one, or a row no one has signed in as yet.
  if new.last_sign_in_at is null then return new; end if;
  if tg_op = 'UPDATE' and old.last_sign_in_at is not null then return new; end if;
  if coalesce(new.is_anonymous, false) then return new; end if;

  select s.decrypted_secret into hook
  from vault.decrypted_secrets s
  where s.name = 'signup_slack_webhook_url'
  limit 1;
  if coalesce(hook, '') = '' then return new; end if;

  display_name := coalesce(
    nullif(new.raw_user_meta_data->>'full_name', ''),
    nullif(new.raw_user_meta_data->>'name', ''),
    nullif(new.raw_user_meta_data->>'user_name', '')
  );
  who := coalesce(nullif(new.email, ''), 'no email');
  if display_name is not null then who := display_name || ' (' || who || ')'; end if;
  -- Slack reads &, < and > as markup: a name can't make a link or a mention.
  who := replace(replace(replace(who, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');

  perform net.http_post(
    url := hook,
    body := jsonb_build_object(
      'text',
      format(':wave: New sign-up: %s via %s', who, coalesce(new.raw_app_meta_data->>'provider', 'unknown'))
    ),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  return new;
exception when others then
  raise warning 'announce_signup: %', sqlerrm;
  return new;
end;
$$;

revoke all on function announce_signup() from public;

drop trigger if exists auth_users_announce_signup on auth.users;
create trigger auth_users_announce_signup
  after insert or update of last_sign_in_at on auth.users
  for each row
  when (new.last_sign_in_at is not null)
  execute function announce_signup();
