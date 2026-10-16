-- How big a new Outrunner sandbox is for this user (Settings → Sandbox; the
-- sizes are lib/runtime/box-sizes.ts). Only new sandboxes are made at it; one
-- already running keeps its size. 'large' is allowed here so a higher plan
-- can unlock it without a migration; the app refuses it until then.
-- ---------------------------------------------------------------------------

alter table user_credentials
  add column if not exists box_size text not null default 'small';

alter table user_credentials
  drop constraint if exists user_credentials_box_size_check;
alter table user_credentials
  add constraint user_credentials_box_size_check
  check (box_size in ('x-small', 'small', 'medium', 'large'));
