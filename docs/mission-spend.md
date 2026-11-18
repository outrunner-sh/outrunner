# Mission spend

What a Mission and its Ships have spent, by UTC day and ISO week, and how
well each figure is known. It is the ground a dollar budget for a Mission
(a Slack on-call Mission's, first) will stand on; the budget itself, its UI
and its enforcement come later.

This is **policy accounting**, nothing more:

- It bills no one and changes nothing about who pays. Calls run on whatever
  they ran on before: the owner's Claude subscription, their own keys, or
  Outrunner's models on their allowance.
- It never moves a key's cap. The owner's OpenRouter key keeps its one cap
  (`lib/billing/model-allowance.ts`), for all their sessions together.
- It isn't an invoice ledger: estimates are labelled as estimates, and an
  unknown cost is shown as unknown.

## What counts

A Mission's **family** is its own session, its Ships (sessions whose
`parent_mission_id` is the Mission, archived ones included), and classifier
calls made for it. Each model call is one row of `mission_usage`, under a
reference unique to the call across every Mission:

| Source | Reference | Coverage |
| --- | --- | --- |
| A Claude Code reply (Mission or Ship) | `claude:<message id>`: the API's id, the same on every record of the reply | `estimated` on the cost basis; `unavailable` for a model it doesn't price |
| A Codex call (a Ship on Codex) | `codex:<record uuid>`: the record its token count is put on | `estimated` where `MISSION_COST_BASIS` prices the model, else `unavailable` |
| A classifier call through OpenRouter | `openrouter:<generation id>` | `reported` when OpenRouter states the call's cost; else `estimated` from its tokens; else `unavailable` |
| A reply from an agent before usage, or before `callId` | `unattributed:<session>:<record uuid>` | always `unavailable`: its records can't be told apart into calls |
| A turn cut off unread (box down, paused or archived mid-turn) | `gap:<session>:<box>:<cursor>:<UTC day>` | `unavailable` until the same box's log is read on from that cursor |
| A call the database refuses for its data | `refused:<reference>` | `unavailable` stand-in: a call too odd to store still isn't $0 |
| Compute (the family's boxes) | `compute_intervals` | `reported`: vCPU-hours priced at the plan's included rate |

So sessions' model spend is **estimated** today: Claude Code's log says each
call's tokens and model, not its price. Only a provider that states a call's
cost (OpenRouter, asked with `usage: {include: true}`) gives **reported**.

**Once, however often it's read.** Claude logs each block of a reply as its
own record, each with the reply's usage so far, and a log can be read again
(a restored box, a cursor reset, a forked transcript). The reference is the
call's, not the record's; `record_mission_usage` keeps one row per reference
and takes a later reading only if it has more tokens (or a better-known cost,
never a reported one replaced). A call is the first Mission's that recorded
it: another Mission's reading changes nothing.

**When it's read.** `readSession` (`lib/session/watch.ts`), which the
sessions tick runs every two minutes for every session whose box is up, and
the watches run after each send, records the family's calls in what it read
before its cursor moves on. A failure there fails the read, so the same
events are read again. A call refused for its own data (a value no retry
changes) can't hold the session's reads back: its batch is retried a call
at a time and that call goes in as an `unavailable` stand-in, or, if even
that is refused, is logged and left out. Deployed before its migration,
recording is skipped with a log rather than stopping Missions' reads.

**Cut off mid-turn.** When `readSession` finds a family session's turn
still running but its box down (or the session paused or archived), what it
did since the last read may never be read. It records a `gap:` entry,
`unavailable`, on each UTC day from the last read to when the box stopped
(its latest `compute_intervals` end or sighting; now for a box that isn't
metered), at most 31 days. So each day the stretch touches, and none after,
says it isn't covered. When the box comes back with its log (the same box,
started again) and a read goes on from that cursor, the stretch is being
read after all: the gap's entries are removed, by key, and its calls
counted as usual. A box that's really gone keeps its gap.

**Classifier calls.** `oneShot` (`lib/slack/agent-model.ts`) takes an
`onAnswer` that hears OpenRouter's answer; pass
`(answer) => recordClassifierCall(missionId, answer)`
(`lib/missions/spend.deps.ts`) where a classifier works for a Mission. A
watched channel's filter does (`lib/missions/automation-target.deps.ts`):
each message it reads is one call on the Mission's spend.

## Coverage

Each figure says how it's known:

- `reported`: every call in it had a cost its provider stated.
- `estimated`: some were priced on a cost basis, whose versions are listed
  (`costBases`).
- `unavailable`: some cost isn't known: a call that couldn't be counted or
  priced, or a family session whose box came up (made, woken, restored)
  more than ten minutes ago and whose log hasn't been read since (its box
  stopped unread). Sessions that never ran an agent (still being made, or
  failed) don't count. Its dollars are **null, never
  0**; `knownUsd` is what is known, a lower bound.

`calls.unavailable` counts entries, not strictly calls: each block of an old
agent's reply, and each gap, is one.

A period with nothing in it and every session read is a known `reported` $0.

### The cost basis

`lib/missions/cost-basis.ts`: Anthropic's first-party list prices per
million tokens, versioned (`anthropic-list-2026-11-18`). Cache writes at the
5-minute rate (1.25× input), and those the log says went to the 1-hour cache
(`cache_creation.ephemeral_1h_input_tokens`) at 2× input; cache reads at the
listed rate, or 0.1× input. A fast-mode call (`speed: "fast"`) costs twice. Haiku 5.5's prompts over 100K tokens at its
higher rate. Model names are matched without `anthropic/`, `[1m]` or a date
suffix. A price change is a new version; rows keep the version they were
priced on.

For a Claude subscription or the owner's own key, an estimate is what the
tokens would cost at list price, not what that account was charged.

`MISSION_COST_BASIS` adds prices for models the list doesn't have
(Outrunner's OpenRouter models, Codex's), under its own version:

```json
{ "version": "or-2026-11", "models": { "z-ai/glm-5.3": { "input": 0.5, "output": 2, "cacheRead": 0.1 } } }
```

`cacheWrite` and `cacheRead` default to the input price. Set wrong, it's
logged and ignored: those models stay `unavailable`.

### Compute

The family's boxes' `compute_intervals` within the period, as vCPU-hours
counted the way an org's cloud usage is (`vcpuHoursUsed`,
`lib/billing/usage.ts`: each ended session at least a minute), priced at the
plan's **included** rate (`INCLUDED_CENTS_PER_VCPU_HOUR`, 12¢ a vCPU-hour).
That is the rate an org's usage and its dollar limit are measured at, so a
Mission's budget and its org's limit speak the same dollars. It is never the
overage rate: whether a box's minutes fall past the plan's included usage
depends on the org's other sessions, not the Mission's. There is no second
rate to configure. Compute is `reported` (recorded intervals priced by
rule), shown apart from the models, and always in `total`; an unknown model
call still makes `total.usd` null, with compute in `knownUsd`.

## Periods

- **day:** the UTC calendar day, 00:00 to 00:00.
- **week:** the ISO week, Monday 00:00 UTC to the next Monday.

A call is in the period of its time as its log says it (the box's clock).

## Reservations

A policy hold against a Mission's spend before work whose cost isn't known,
for a budget to check against. `lib/missions/spend.deps.ts`:

| Call | What it does |
| --- | --- |
| `reserveMissionSpend(mission, operationId, usd, holdSeconds)` | Hold `usd`. The same operation again is the same reservation (`replayed`), whatever it asks. |
| `renewMissionSpend(mission, operationId, usd \| null, holdSeconds)` | Hold longer, and at least `usd`. Never lowers or shortens a hold; holds a **lapsed** one again. One settled, with a cost or without, is over: left as it is (`replayed`). |
| `settleMissionSpend(mission, operationId, actualUsd \| null)` | With the cost known, the hold is released (the cost itself is the usage recorded for the call). With it unknown, the hold stays as **uncertain** liability, to be settled again once known. Settled with a cost, a repeat is replayed. |

A reservation's state is `held` (live until it expires), `lapsed` (expired
unsettled), `uncertain` (settled without a cost) or `settled`. Lapsed and
uncertain both count as uncertain liability; only a renew tells them apart,
holding a lapsed one again but not an operation that's over.

Each runs in one SQL function under a lock on the Mission's row, so racing
callers see each other's holds; each answers with the Mission's live holds
(`heldUsd`) and uncertain liability (`uncertainUsd`) after it. A hold that
lapses unsettled counts as uncertain: liability is never dropped by time,
only by a settle with a cost. The spend read shows both as `reservations`,
as they stand now, whatever the period.

## Reading it

`GET /api/missions/[id]/spend?period=day|week&at=<ISO time>`: the Mission's
owner only; `period` defaults to `day`, `at` to now.

```json
{
  "spend": {
    "missionId": "…",
    "period": { "kind": "week", "start": "2026-11-09T00:00:00.000Z", "end": "2026-11-16T00:00:00.000Z" },
    "models": {
      "coverage": "estimated", "usd": 3.41, "knownUsd": 3.41,
      "reportedUsd": 0.01, "estimatedUsd": 3.4,
      "calls": { "reported": 2, "estimated": 412, "unavailable": 0 },
      "costBases": ["anthropic-list-2026-11-18"],
      "tokens": { "input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0 },
      "unreadSessions": 0
    },
    "compute": { "vcpuHours": 13, "usd": 1.56, "centsPerVcpuHour": 12, "coverage": "reported" },
    "total": { "coverage": "estimated", "usd": 4.97, "knownUsd": 4.97 },
    "reservations": { "heldUsd": 0, "uncertainUsd": 0, "openReservations": 0 }
  }
}
```

In code, `readMissionSpend(missionId, kind, at)`.

## Pieces

| Piece | Where |
| --- | --- |
| Tables and functions | `supabase/migrations/20261119110000_mission_spend.sql` |
| Calls, periods, coverage (pure) | `lib/missions/spend.ts` |
| Cost basis | `lib/missions/cost-basis.ts`; compute's rate is `lib/billing/usage.ts` |
| Database side, reservations | `lib/missions/spend.deps.ts` |
| Recording a family's calls | `lib/session/watch.ts` (`readSession`) |
| A reply's call id | runtime-agent `internal/conversation/watcher.go` (`callId`, from the log's `message.id`) |
| The read API | `app/api/missions/[id]/spend/route.ts` |

Both tables are service-role only (row level security on, no policies,
nothing granted to `anon` or `authenticated`), as the other Missions tables.

## Setting it up

1. Run `pnpm db:migrate` (`20261119110000_mission_spend.sql`).
2. Deploy. Boxes made after the deploy run a runtime-agent that names each
   reply's call (`callId`); a box from before goes on with its own agent, and
   its replies count as `unavailable` until it's rebuilt.
3. Optional: set `MISSION_COST_BASIS` to price models the list doesn't. Its
   prices are estimates and say their version. Compute needs nothing set.

## Known gaps

- A Claude Code subagent writes its own log, which the session's stream
  doesn't carry: its calls aren't counted yet, so a session's estimate is a
  lower bound where it used subagents.
- A box lost mid-turn takes its unread calls with it; the period shows a
  gap (`unavailable`). If its log is later read on another box (a restore),
  the calls are counted, but the gap stays: the period stays `unavailable`
  rather than claim coverage it can't prove.
- Compute counts only boxes tied to a family workspace
  (`runtime_computers.workspace_id`). Time on a project-shared box
  (`workspace_id` null) isn't counted, so a family that works on one is
  under-counted by that time.

## Tests

- `test/mission-spend.test.ts`: periods and their rollover, one call per
  reply however its records are read, Codex calls, classifier calls,
  coverage (never $0 for unknown), compute at the included rate, the cost
  basis.
- `test/mission-spend-sql.test.ts` (needs `MISSIONS_PG`): once per call
  under racing writes, reported never replaced, one Mission per call, period
  boundaries, reservations' idempotence, lock, lapse and settle, and that
  only the service role reaches it.
- runtime-agent `TestDecodeNamesTheCallItsUsageIsFrom`: the call id on
  every record of a reply.
