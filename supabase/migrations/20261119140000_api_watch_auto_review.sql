-- A session started through the API with `auto_create_pr` is asked to review
-- its pull request once it opens one: "Review my changes" with
-- `Review request.md` attached, as the app's Review button sends it
-- (lib/api/auto-review.ts). Sent once, as the PR is told as pr.opened.
alter table api_watches add column if not exists auto_review boolean not null default false;
