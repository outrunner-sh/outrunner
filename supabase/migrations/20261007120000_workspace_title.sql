-- A session's title: what the user first asked for, shown in the sidebar in
-- place of the generated branch name (runtime/muyc8h2e-26700eb2).
--
-- Null until the first prompt is delivered (POST /api/workspaces/:id/message),
-- which sets it once and never again (`where title is null`). Sessions created
-- before this column get theirs on their next prompt.

alter table workspaces add column if not exists title text;

alter table workspaces drop constraint if exists workspaces_title_length;
alter table workspaces add constraint workspaces_title_length
  check (title is null or char_length(title) between 1 and 200);
