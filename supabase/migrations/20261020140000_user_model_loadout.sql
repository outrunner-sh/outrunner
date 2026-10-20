-- A user's model loadout (Settings → Default models): the models the chat
-- picker shows first, in order, and the one a new session starts on. Each is
-- {provider, id}, as the model menu names it (lib/runtime/model-loadout.ts),
-- checked by the app on the way in and out. One row per user.
--
-- Not a credential, but reached the same way, only through the service role
-- (lib/db/model-loadout.ts): RLS on with no policy, every grant revoked.
-- ---------------------------------------------------------------------------

create table if not exists user_model_loadout (
  user_id uuid primary key references auth.users (id) on delete cascade,
  models jsonb not null default '[]'::jsonb check (jsonb_typeof(models) = 'array' and jsonb_array_length(models) <= 12),
  default_model jsonb check (default_model is null or jsonb_typeof(default_model) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists user_model_loadout_set_updated_at on user_model_loadout;
create trigger user_model_loadout_set_updated_at
  before update on user_model_loadout
  for each row execute function set_updated_at();

alter table user_model_loadout enable row level security;
revoke all on table user_model_loadout from anon, authenticated;
