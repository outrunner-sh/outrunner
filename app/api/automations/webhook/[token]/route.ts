import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { after } from "@/lib/observability/after";

import { type PendingRun, recordOf, startRun, type StartDeps } from "@/lib/automations/runs";
import { startDeps } from "@/lib/automations/start-deps";
import {
  isWebhookToken,
  WEBHOOK_BODY_MAX,
  webhookDedupeKey,
  type WebhookEvent,
} from "@/lib/automations/webhook";
import { automationCandidates, recordRuns } from "@/lib/db/automation-runs";
import { open } from "@/lib/crypto/secret-box";
import { checkMissionWebhook, sameDelivery } from "@/lib/missions/webhook-target";
import { runsByKey, webhookAutomation } from "@/lib/db/automation-webhooks";
import { optionalEnv } from "@/lib/env";
import { githubAppConfig } from "@/lib/github/app";
import { readCappedBody } from "@/lib/http/capped-body";
import { databaseNotUpdated } from "@/lib/http/database-not-updated";
import { clientAddress, RateLimiter, type Taken } from "@/lib/http/rate-limit";

/** Any one address: a caller trying tokens is slowed long before it finds
 *  one (each is 32 random bytes). */
const perAddress = new RateLimiter([{ ms: 60_000, max: 60 }]);
/** Any one automation: each request is a session, with a box. */
const perAutomation = new RateLimiter([
  { ms: 60_000, max: 20 },
  { ms: 3_600_000, max: 200 },
]);

/** How long `?wait_for_workspace=true` waits for each run's session to be
 *  made (its row, not its box's setup, which takes minutes). */
const WAIT_MS = 60_000;

type Params = { params: Promise<{ token: string }> };

function tooMany(taken: Extract<Taken, { ok: false }>): Response {
  return NextResponse.json(
    { error: "Too many requests. Try again later." },
    { status: 429, headers: { "retry-after": String(taken.retryAfterSeconds) } },
  );
}

const NOT_FOUND = { error: "No such webhook." };

/**
 * An automation's webhook: a POST of JSON to its secret URL starts a run on
 * each of its repositories (or only `?repo=owner/name`), the payload in its
 * session's prompt (lib/automations/webhook.ts). The URL is the only key, so
 * it's rate limited, by address and by automation, and an admin can rotate
 * it. An `Idempotency-Key` header makes a retried request start nothing
 * twice: it's answered with the first one's runs.
 *
 * Answered at once with the runs' ids (202); with `?wait_for_workspace=true`,
 * once each run's session is made, with its id and where to open it (200),
 * or as far as it got within a minute (202).
 */
export async function POST(request: Request, { params }: Params) {
  const { token } = await params;
  const address = perAddress.take(clientAddress(request.headers));
  if (!address.ok) return tooMany(address);
  if (!isWebhookToken(token)) return NextResponse.json(NOT_FOUND, { status: 404 });

  try {
    // Its automation first: a token that's none is answered without its body
    // being read at all.
    const automation = await webhookAutomation(token);
    if (!automation) return NextResponse.json(NOT_FOUND, { status: 404 });
    // A session's run works on GitHub as the App; a Mission's makes a request.
    if (!automation.mission && !githubAppConfig()) {
      return NextResponse.json({ error: "Automations can't run here: the GitHub App isn't set up." }, { status: 503 });
    }
    if (!automation.live) {
      return NextResponse.json({ error: "This automation is off, or doesn't run on its webhook." }, { status: 409 });
    }
    const limit = perAutomation.take(automation.automationId);
    if (!limit.ok) return tooMany(limit);
    // Read only as far as the limit, a chunked body (no Content-Length)
    // included: what's past it is never held.
    const raw = await readCappedBody(request, WEBHOOK_BODY_MAX);
    if (raw === null) {
      return NextResponse.json({ error: `Send at most ${WEBHOOK_BODY_MAX / 1024} KB of JSON.` }, { status: 413 });
    }

    let payload: unknown = null;
    if (raw.trim() !== "") {
      try {
        payload = JSON.parse(raw);
      } catch {
        return NextResponse.json({ error: "Send the payload as JSON." }, { status: 400 });
      }
    }
    // A Mission's: a delivery key required, the signature checked when it
    // has a secret (lib/missions/webhook-target.ts).
    let missionCheck: { key: string; payloadHash: string } | null = null;
    if (automation.mission) {
      const checked = checkMissionWebhook({ headers: request.headers, raw, secret: automation.hmacSealed ? open(automation.hmacSealed) : null });
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: checked.status });
      missionCheck = checked;
    }
    const dedupeKey = missionCheck?.key ?? webhookDedupeKey(request.headers.get("idempotency-key"), randomUUID());
    if (!dedupeKey) return NextResponse.json({ error: "That Idempotency-Key isn't one: 1 to 200 characters." }, { status: 400 });
    const url = new URL(request.url);
    const repo = url.searchParams.get("repo")?.trim().toLowerCase() || null;
    const wait = url.searchParams.get("wait_for_workspace") === "true";

    const candidates = (await automationCandidates([automation.automationId])).filter(
      (c) => !repo || c.repoFullName.toLowerCase() === repo,
    );
    if (candidates.length === 0) {
      return NextResponse.json(
        { error: repo ? `This automation doesn't run on ${repo}.` : "This automation runs on no repository." },
        { status: repo ? 400 : 409 },
      );
    }
    const event: WebhookEvent = {
      trigger: "webhook",
      receivedAt: new Date().toISOString(),
      payload,
      ...(missionCheck && { payloadHash: missionCheck.payloadHash }),
    };
    const recorded = await recordRuns(candidates.map((c) => recordOf(c, event, dedupeKey)));
    const base = optionalEnv("RUNTIME_BASE_URL") ?? url.origin;
    // A team org's run sessions are its connector's: its admins read them on
    // the run's page. A personal org's are its owner's own.
    const sessionUrl = (runId: string, workspaceId: string | null) =>
      workspaceId
        ? new URL(automation.personal ? `/workspaces/${workspaceId}` : `/automations/runs/${runId}`, base).toString()
        : null;
    const repoOf = new Map(candidates.map((c) => [c.projectId, c.repoFullName]));

    if (recorded.size === 0) {
      // A retry of a request already taken: answered with its runs. Else
      // none was taken: it has run as many times as it's set to (and
      // switched itself off), or was switched off just now.
      const taken = await runsByKey(automation.automationId, dedupeKey);
      if (taken.length === 0) {
        return NextResponse.json({ error: "This automation has run as many times as it's set to, or is off." }, { status: 409 });
      }
      if (missionCheck && !sameDelivery(taken, missionCheck.payloadHash)) {
        return NextResponse.json({ error: "That delivery key was used before with a different payload." }, { status: 409 });
      }
      const runs = taken.map((r) => ({
        runId: r.runId,
        repository: repoOf.get(r.projectId) ?? null,
        status: r.status,
        reason: r.reason,
        sessionId: r.workspaceId,
        sessionUrl: sessionUrl(r.runId, r.workspaceId),
      }));
      return NextResponse.json({ duplicate: true, ...single(runs), runs });
    }

    const pending: PendingRun[] = candidates.flatMap((candidate) => {
      const run = recorded.get(`${candidate.automationId}:${candidate.projectId}`);
      return run ? [{ runId: run.runId, candidate, event, ...(run.queued ? { queued: true } : {}) }] : [];
    });
    // Each started now and kept going after the answer; told when its
    // session is made (or it isn't), for a caller that waits. One waiting
    // out its automation's debounce window is answered as such at once: its
    // session comes once the window passes, maybe for a later request.
    const made = pending.map((run) => {
      if (run.queued) {
        const waiting = startRun(run, startDeps());
        after(() => waiting);
        return Promise.resolve<Made>({ status: "queued" });
      }
      let tell: (outcome: Made) => void = () => {};
      const told = new Promise<Made>((resolve) => (tell = resolve));
      const deps = startDeps();
      const watched: StartDeps = {
        ...deps,
        settleRun: async (runId, outcome) => {
          await deps.settleRun(runId, outcome);
          if (outcome.workspaceId || outcome.status !== "started") tell(outcome);
        },
      };
      const started = startRun(run, watched).finally(() => tell({ status: "failed", reason: "It stopped without saying how." }));
      after(() => started);
      return told;
    });
    if (!wait) {
      const runs = pending.map((run) => ({
        runId: run.runId,
        repository: run.candidate.repoFullName,
        status: run.queued ? "queued" : "starting",
      }));
      return NextResponse.json({ ...single(runs), runs }, { status: 202 });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcomes = await Promise.race([
      Promise.all(made),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    const settled = outcomes ?? (await Promise.all(made.map((m) => Promise.race([m, Promise.resolve(null)]))));
    const runs = pending.map((run, i) => {
      const outcome = settled[i];
      return {
        runId: run.runId,
        repository: run.candidate.repoFullName,
        status: outcome?.status ?? "starting",
        reason: outcome?.reason ?? null,
        sessionId: outcome?.workspaceId ?? null,
        sessionUrl: sessionUrl(run.runId, outcome?.workspaceId ?? null),
      };
    });
    return NextResponse.json({ ...single(runs), runs }, { status: outcomes ? 200 : 202 });
  } catch (error) {
    const notUpdated = databaseNotUpdated(error, "a webhook's run");
    if (notUpdated) return notUpdated;
    console.error("An automation's webhook failed", error);
    return NextResponse.json({ error: "Couldn't start the run. Try again." }, { status: 500 });
  }
}

/** How far a run's start got: its session made (its id), or not, saying why. */
type Made = { status: string; workspaceId?: string | null; reason?: string | null };

/** The one run's fields at the top too, for the usual automation on one
 *  repository. */
function single<T extends object>(runs: T[]): Partial<T> {
  return runs.length === 1 ? runs[0] : {};
}
