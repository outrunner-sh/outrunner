-- 20261028170000 filled pull_requests.project_id for a deploy from before it,
-- which didn't name it, so the column could be not null during the rollout.
-- Every insert names it now: one that forgets fails on the not null rather
-- than being filled in quietly.
--
-- Apply only once the code of #179 runs everywhere (a deploy from before it
-- would fail to record a pull request).
-- ---------------------------------------------------------------------------

drop trigger if exists pull_requests_default_project on pull_requests;
drop function if exists pull_requests_default_project();
