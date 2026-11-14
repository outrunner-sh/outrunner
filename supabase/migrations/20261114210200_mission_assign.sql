-- Phase 3: `!assign @person` records who owns a thread's open request (and so
-- its Ships). The Mission keeps working; Ships still run as the owner.
alter table mission_slack_requests add column if not exists assignee_user_id uuid references auth.users (id) on delete set null;
alter table mission_slack_requests add column if not exists assigned_by uuid references auth.users (id) on delete set null;
alter table mission_slack_requests add column if not exists assigned_at timestamptz;
