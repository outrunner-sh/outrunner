-- A plan caps how many of Outrunner's boxes a user runs at once
-- (lib/billing/plans.ts, concurrentCloudSessions, counted in boxes: the limit
-- protects boxes — sessions share one per project — and plans.ts defines it as
-- "Outrunner sandboxes running at once"). The cap is enforced here, inside the
-- claim, so it cannot be raced past: two requests starting boxes at the same
-- moment, on different projects where the per-project lock does not serialise
-- them, meet a per-user lock and a count in one transaction.
--
-- A claim passes max_live_computers = null when no cap applies: the
-- deployment's owners (RUNTIME_OWNER_GITHUB_LOGIN; an unset allowlist is an
-- open deployment), or a box on the user's own Daytona or Modal, which is
-- their bill, not the plan's (lib/billing/limits.ts).
--
-- The count mirrors liveMeteredComputers in lib/billing/limits.ts; keep the
-- two together.

-- How many of the owner's boxes the plan limits are running: ready, or
-- provisioning while still fresh (a claim whose provision died holds no slot
-- forever), and never on the owner's own Daytona or Modal.
create or replace function live_metered_computers(for_owner uuid)
returns bigint
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select count(*)
  from runtime_computers
  where owner_id = for_owner
    and (provider is null or provider not in ('user-daytona', 'user-modal'))
    and (
      status = 'ready'
      or (status = 'provisioning' and updated_at > now() - interval '10 minutes')
    )
$$;

-- Refuse a claim that would start a box past the plan's cap. Called on the
-- claim's two would-provision paths, after the per-project lock, under a
-- per-user lock, so count-then-claim is one transaction.
create or replace function check_plan_box_cap(for_owner uuid, max_live integer)
returns void
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
begin
  if max_live is null then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext('claim_runtime_computer:' || for_owner::text));
  if live_metered_computers(for_owner) >= max_live then
    raise exception 'Your plan''s % concurrent cloud sessions are already running. End one to free its box (idle boxes pause within 15 minutes), or upgrade for more.', max_live
      using errcode = 'P4BX1';
  end if;
end $$;

-- claim_runtime_computer, with the plan's box cap. Everything else is as it
-- was (20260805140000, 20260805150000).
--
-- The old three-argument function is dropped first: create-or-replace with a
-- longer argument list would leave it beside this one as an overload, and
-- PostgREST does not call overloaded functions. The arguments keep their
-- defaults, so a caller that passes only the first two still resolves here.
drop function if exists claim_runtime_computer(uuid, text, text);
create or replace function claim_runtime_computer(
  requested_project_id uuid,
  requested_agent_secret text,
  requested_image_version text default 'v1',
  max_live_computers integer default null
)
returns table (
  runtime_computer_id uuid,
  should_provision boolean
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  existing runtime_computers%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  -- Confirm both existence and ownership before acquiring a project-scoped
  -- lock. This keeps the RPC subject to the same access boundary as direct
  -- table reads under RLS.
  perform 1
  from projects
  where id = requested_project_id
    and owner_id = auth.uid();
  if not found then
    raise exception 'project not found';
  end if;

  perform pg_advisory_xact_lock(hashtext(requested_project_id::text));

  select * into existing
  from runtime_computers
  where project_id = requested_project_id;

  if found then
    -- A failed/stopped computer is retried in-place. Keeping the same row
    -- preserves the one-computer-per-project identity and avoids a duplicate
    -- external provision during concurrent retries.
    if existing.status in ('error', 'stopped') then
      perform check_plan_box_cap(auth.uid(), max_live_computers);
      update runtime_computers
      set status = 'provisioning',
          agent_secret = requested_agent_secret,
          daytona_sandbox_id = null,
          agent_base_url = null,
          provision_timings = null,
          error_message = null
      where id = existing.id;
      return query select existing.id, true;
    end if;

    return query select existing.id, false;
    return;
  end if;

  perform check_plan_box_cap(auth.uid(), max_live_computers);

  insert into runtime_computers (
    owner_id,
    project_id,
    agent_secret,
    image_version,
    status
  ) values (
    auth.uid(),
    requested_project_id,
    requested_agent_secret,
    requested_image_version,
    'provisioning'
  ) returning id into existing.id;

  return query select existing.id, true;
end;
$$;
