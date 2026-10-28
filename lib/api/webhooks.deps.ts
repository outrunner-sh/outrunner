/**
 * Webhooks at work (lib/api/webhooks.ts has the rules): a session started
 * through the API is watched (api_watches), and what it does is told to its
 * `webhook_url` and to its scope's endpoint, signed.
 *
 *   workspace.ready   its setup ended and its prompt was sent
 *   error             its setup failed, or it did later
 *   turn.completed    a turn after a message (its first prompt too) is over
 *   needs_input       it asked a question, or for secrets
 *   pr.opened         a pull request of its showed up as a turn ended
 *
 * A turn is watched right after the send, in after(), for WATCH_MS, as the
 * Slack relay watches for a reply (lib/slack/relay.ts); the cron's tick
 * (app/api/v1/tick) carries on for turns that outlast it, and tries again
 * deliveries that failed.
 */

import { lookup } from "node:dns/promises";

import { after } from "next/server";

import { GET as pullRequestGET } from "@/app/api/workspaces/[id]/pull-request/route";
import type { ApiCaller } from "@/lib/api/auth";
import { apiError } from "@/lib/api/errors";
import { appRequest, routeParams, type ApiContext } from "@/lib/api/handler";
import { workspaceJson } from "@/lib/api/serialize";
import {
  eventBody,
  isPrivateAddress,
  nextAttemptAt,
  signature,
  watchStep,
  webhookUrl,
  type WebhookEvent,
} from "@/lib/api/webhooks";
import { turnJsonOf, type CreateHooks } from "@/lib/api/workspaces";
import {
  advanceWatch,
  awaitTurn,
  claimDelivery,
  createWatch,
  dueDeliveries,
  dueWatches,
  endWatch,
  enqueueDeliveries,
  expireWatches,
  getWatch,
  pruneDeliveries,
  settleDelivery,
  webhookSettings,
  type Delivery,
  type Watch,
  type WebhookScope,
} from "@/lib/db/api-webhooks";
import { pruneApiRequests } from "@/lib/db/api-keys";
import { getWorkspace } from "@/lib/db/repositories";
import { optionalEnv } from "@/lib/env";
import type { Workspace } from "@/lib/runtime/types";
import { actAsUserKept, holdActingUser } from "@/lib/supabase/acting-user";

/** How long a turn's end is awaited after a send. */
const AWAIT_MS = 2 * 60 * 60_000;
/** How long the send's own watch lasts before the tick takes over. */
const WATCH_MS = 10 * 60_000;
const WATCH_EVERY_MS = 10_000;
const DELIVERY_TIMEOUT_MS = 10_000;

function base(): string {
  return optionalEnv("RUNTIME_BASE_URL") ?? "http://localhost";
}

/** Whose secret signs a caller's events. */
export function scopeOf(caller: ApiCaller): WebhookScope {
  return caller.kind === "org_key" ? { scope: "org", scopeId: caller.orgId } : { scope: "user", scopeId: caller.userId };
}

/** The create's hooks: the session is watched from the moment it's made. */
export function webhookHooks(context: ApiContext): CreateHooks {
  const who = scopeOf(context.caller);
  let workspaceId: string | null = null;
  // Its setup may settle before the create has answered (rare, a fast
  // box): whichever comes second acts.
  let settled: Parameters<NonNullable<CreateHooks["onSettled"]>>[0] | null = null;
  return {
    async onCreated(workspace, input) {
      await createWatch({
        workspaceId: workspace.id,
        orgId: context.caller.orgId,
        userId: context.caller.userId,
        who,
        webhookUrl: input.webhookUrl,
      });
      workspaceId = workspace.id;
      if (settled) await setupEnded(settled);
    },
    async onSettled(outcome) {
      settled = outcome;
      if (workspaceId) await setupEnded(outcome);
    },
  };
}

/** A webhook_url as a create posts it, or the answer refusing it. */
export function checkWebhookUrl(value: string | null): Response | null {
  if (value === null) return null;
  return webhookUrl(value) ? null : apiError(400, "`webhook_url` must be an https URL on the public internet.");
}

async function setupEnded(outcome: { workspaceId: string; status: "ready" | "failed"; errorMessage?: string }): Promise<void> {
  const watch = await getWatch(outcome.workspaceId);
  if (!watch) return;
  const workspace = await getWorkspace(outcome.workspaceId).catch(() => null);
  if (outcome.status === "failed") {
    // Watched from its making, with watch_until unset: told here, once.
    await endWatch(watch.workspaceId);
    await emit(watch, "error", workspace, { message: outcome.errorMessage ?? "The session's setup failed." });
    return;
  }
  await emit(watch, "workspace.ready", workspace, {});
  // Its first prompt went with the ready: its turn's end is awaited.
  await turnAwaited(watch.workspaceId);
}

/** After a message the API sent: its turn's end is awaited. */
export async function messageSent(workspace: Workspace): Promise<void> {
  if (!(await getWatch(workspace.id))) return;
  await turnAwaited(workspace.id);
}

async function turnAwaited(workspaceId: string): Promise<void> {
  await awaitTurn(workspaceId, AWAIT_MS);
  // Watched as the session's owner, on their kept sign-in, after the answer.
  const release = holdActingUser();
  later(async () => {
    try {
      await watchFor(workspaceId, WATCH_MS);
    } finally {
      release();
    }
  });
}

/** After the answer, where there's one to wait for; else (already after
 *  it: a session's setup) now, without holding up its caller. */
function later(work: () => Promise<void>): void {
  const run = () => work().catch((error: unknown) => console.error("Webhooks: a watch failed", error));
  try {
    after(run);
  } catch {
    void run();
  }
}

async function watchFor(workspaceId: string, forMs: number): Promise<void> {
  const until = Date.now() + forMs;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, WATCH_EVERY_MS));
    const going = await lookOnce(workspaceId).catch((error: unknown) => {
      console.error(`Webhooks: couldn't look at ${workspaceId}`, error);
      return true;
    });
    if (!going) return;
  }
}

/**
 * Look at a watched session once, as its owner, and tell what's new. False
 * once there's nothing left to watch for.
 */
async function lookOnce(workspaceId: string): Promise<boolean> {
  const watch = await getWatch(workspaceId);
  if (!watch || !watch.watchUntil) return false;
  const workspace = await getWorkspace(workspaceId);
  if (!workspace || workspace.status === "destroying" || workspace.status === "destroyed") {
    await endWatch(workspaceId);
    return false;
  }
  if (workspace.status === "failed") {
    if (await endWatch(workspaceId)) {
      await emit(watch, "error", workspace, { message: workspace.errorMessage ?? "The session failed." });
    }
    return false;
  }
  if (workspace.status !== "ready" && workspace.status !== "idle") return true;

  const turn = await turnJsonOf(workspace);
  const step = watchStep(watch, turn as Parameters<typeof watchStep>[1]);
  if (step.events.length === 0) {
    await advanceWatch(workspaceId, watch, step.next);
    return step.next.awaiting;
  }
  const done = step.events.includes("turn.completed");
  const prs = done ? await newPullRequests(workspace, watch) : null;
  const moved = await advanceWatch(workspaceId, watch, {
    ...step.next,
    ...(prs && { toldPrs: [...watch.toldPrs, ...prs.map((p) => p.key)] }),
    ...(done && { watchUntil: null }),
  });
  // Another look told it first.
  if (!moved) return true;
  for (const event of step.events) await emit(watch, event, workspace, { turn });
  for (const pr of prs ?? []) await emit(watch, "pr.opened", workspace, { pull_request: pr.pullRequest, project_id: pr.projectId });
  return step.next.awaiting;
}

type FoundPullRequest = { key: string; projectId: string; pullRequest: Record<string, unknown> };

/** The session's pull requests not yet told, as its pull-request route finds them. */
async function newPullRequests(workspace: Workspace, watch: Watch): Promise<FoundPullRequest[]> {
  const repos = workspace.checkouts?.map((c) => c.projectId) ?? [workspace.projectId];
  const found: FoundPullRequest[] = [];
  for (const projectId of repos) {
    const path = `/api/workspaces/${workspace.id}/pull-request${workspace.checkouts ? `?projectId=${projectId}` : ""}`;
    const answer = await pullRequestGET(appRequest(base(), path, { method: "GET" }), routeParams({ id: workspace.id })).catch(() => null);
    if (!answer?.ok) continue;
    const { pullRequest } = (await answer.json()) as { pullRequest: { number: number; url: string; title: string; baseBranch: string; headBranch: string } | null };
    if (!pullRequest) continue;
    const key = `${projectId}#${pullRequest.number}`;
    if (watch.toldPrs.includes(key)) continue;
    found.push({
      key,
      projectId,
      pullRequest: {
        number: pullRequest.number,
        url: pullRequest.url,
        title: pullRequest.title,
        base_branch: pullRequest.baseBranch,
        head_branch: pullRequest.headBranch,
      },
    });
  }
  return found;
}

/** Queue `event` for the watch's URLs, and try each at once. */
async function emit(watch: Watch, event: WebhookEvent, workspace: Workspace | null, data: Record<string, unknown>): Promise<void> {
  const settings = await webhookSettings(watch);
  const urls = [...new Set([watch.webhookUrl, settings.url].filter((u): u is string => typeof u === "string"))];
  const createdAt = new Date().toISOString();
  const deliveries = await enqueueDeliveries(watch, watch.workspaceId, event, urls, (id) =>
    eventBody({ id, event, createdAt, workspace: workspace ? workspaceJson(workspace, base()) : { id: watch.workspaceId }, data }),
  );
  for (const delivery of deliveries) await deliver(delivery, settings.secret);
}

/** Try one delivery, if no one else is: delivered on a 2xx, else tried again later. */
async function deliver(delivery: Delivery, secret?: string): Promise<void> {
  if (!(await claimDelivery(delivery.id))) return;
  const attempts = delivery.attempts + 1;
  const body = JSON.stringify(delivery.payload);
  let status: number | null = null;
  let failure: string | null = null;
  try {
    const url = new URL(delivery.url);
    // Checked as it goes: a name can point at a private address later.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await lookup(host, { all: true });
    if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
      throw new Error("The URL's host points at a private address.");
    }
    const signingSecret = secret ?? (await webhookSettings(delivery)).secret;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Outrunner-Webhooks/1",
        "outrunner-event": delivery.event,
        "outrunner-delivery": delivery.id,
        "outrunner-signature": signature(signingSecret, body, Math.floor(Date.now() / 1000)),
      },
      body,
      // A redirect could send it anywhere: it counts as an answer, not followed.
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    status = response.status;
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) failure = `Answered ${response.status}.`;
  } catch (error) {
    failure = error instanceof Error ? error.message : "Couldn't reach it.";
  }
  await settleDelivery(delivery.id, {
    attempts,
    status,
    error: failure,
    delivered: failure === null,
    nextAttemptAt: failure === null ? null : nextAttemptAt(attempts),
  });
}

/**
 * The tick's part: watches no one is looking at (turns that outlast the
 * send's own watch), each looked at as its owner, and deliveries due a try;
 * and old API call records and deliveries let go.
 */
let lastPruned = 0;

export async function runWebhookTick(): Promise<{ watched: number; delivered: number }> {
  await expireWatches();
  // Records kept only so long (api_requests, done deliveries): an hour's
  // worth at a time is plenty, so not on every tick.
  if (Date.now() - lastPruned > 60 * 60_000) {
    lastPruned = Date.now();
    await Promise.all([pruneApiRequests(), pruneDeliveries()]).catch((error: unknown) =>
      console.error("Webhooks tick: couldn't prune old records", error),
    );
  }
  const watches = await dueWatches();
  for (const watch of watches) {
    await actAsUserKept(watch.userId, () => lookOnce(watch.workspaceId)).catch((error: unknown) =>
      console.error(`Webhooks: couldn't look at ${watch.workspaceId}`, error),
    );
  }
  const deliveries = await dueDeliveries();
  for (const delivery of deliveries) {
    await deliver(delivery).catch((error: unknown) => console.error(`Webhooks: delivery ${delivery.id} failed`, error));
  }
  return { watched: watches.length, delivered: deliveries.length };
}
