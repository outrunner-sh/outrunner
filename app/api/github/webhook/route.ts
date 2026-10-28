import { after, NextResponse } from "next/server";

import { closeRuns, planRuns, startRun } from "@/lib/automations/runs";
import { startDeps } from "@/lib/automations/start-deps";
import { finishCheckFromComment } from "@/lib/automations/checks";
import { closeRunCheck, closeRunCheckWithout } from "@/lib/automations/checks.deps";
import {
  automationsForPullRequest,
  openCheckOf,
  openChecksOfPullRequest,
  pullRequestSessions,
  recordRuns,
} from "@/lib/db/automation-runs";
import { archiveServerSessions } from "@/lib/session/server-session";

import {
  forgetInstallation,
  installationHolder,
  recordInstalled,
  setInstallationSuspended,
  updateInstallation,
} from "@/lib/db/github-installations";
import {
  appSlug,
  dropInstallationToken,
  githubAppConfig,
  toInstallation,
  webhookSignatureMatches,
} from "@/lib/github/app";
import { announcePullRequest } from "@/lib/slack/agent-run";

/** A body GitHub sends is far below this; anything bigger isn't GitHub's. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

type Payload = {
  action?: string;
  installation?: {
    id?: number;
    account?: { login: string; type: string } | null;
    repository_selection?: string;
    suspended_at?: string | null;
  };
  account?: { login?: string };
  repository_selection?: string;
  sender?: { id?: number; login?: string };
  repository?: { full_name?: string };
  pull_request?: { number?: number; html_url?: string; title?: string; head?: { ref?: string } };
};

/**
 * The Outrunner GitHub App's webhook. Only what GitHub signed with the App's
 * webhook secret is read. A new installation is recorded unclaimed, with who
 * installed it (the sender), for them to claim for an org
 * (app/api/github/app/setup). After that it keeps the installations true to
 * GitHub: an uninstalled one is forgotten, a suspension is marked, and a
 * renamed account and a changed repository choice are recorded.
 *
 * A pull request event starts the automations of the org that has the
 * installation (lib/automations/runs.ts): their runs are recorded before the
 * answer, their sessions set up after. A redelivery starts nothing twice.
 * An opened one is also posted in the Slack thread of the item its session
 * works on, if the Slack agent filed it.
 */
export async function POST(request: Request) {
  const config = githubAppConfig();
  if (!config) return NextResponse.json({ error: "The GitHub App isn't set up here." }, { status: 503 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Too large." }, { status: 413 });
  }
  const raw = await request.text();
  // A body with no Content-Length (chunked) is measured once read.
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return NextResponse.json({ error: "Too large." }, { status: 413 });
  if (!webhookSignatureMatches(config.webhookSecret, raw, request.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ error: "Bad signature." }, { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  let payload: Payload;
  try {
    payload = JSON.parse(raw) as Payload;
  } catch {
    return NextResponse.json({ error: "Not JSON." }, { status: 400 });
  }
  const installationId = payload.installation?.id;
  if (event === "ping" || typeof installationId !== "number") return new NextResponse(null, { status: 204 });

  try {
    if (event === "installation" && payload.action === "created") {
      const installation = toInstallation(payload.installation ?? {});
      const sender = payload.sender;
      // By GitHub's numeric id: a login can be renamed and taken by another.
      if (installation && typeof sender?.id === "number" && sender.login) {
        await recordInstalled(installation, { id: sender.id, login: sender.login });
      }
      return new NextResponse(null, { status: 204 });
    }
    if (!(await installationHolder(installationId))) return new NextResponse(null, { status: 204 });
    if (event === "pull_request") {
      // Each run's session is set up after the answer, in after(): minutes on
      // a cold box, on Outrunner's long-running server (server.ts). One a
      // restart cuts off is swept by the reconciler (sweepStalledRuns).
      const runs = await planRuns(payload, { automationsForPullRequest, recordRuns }, await appSlug(config));
      after(() => Promise.all(runs.map((run) => startRun(run, startDeps()))));
      // A PR closed or merged: archive its automation runs' review sessions.
      if (payload.action === "closed") {
        after(() =>
          closeRuns(payload, {
            pullRequestSessions,
            archiveServerSessions,
            openChecksOfPullRequest,
            closeCheck: closeRunCheckWithout,
          }),
        );
      }
      // A PR from a session working on an item the Slack agent filed: its
      // thread hears of it.
      const pr = payload.pull_request;
      if (payload.action === "opened" && pr?.head?.ref && pr.html_url && typeof pr.number === "number" && payload.repository?.full_name) {
        const opened = {
          repoFullName: payload.repository.full_name,
          headRef: pr.head.ref,
          number: pr.number,
          url: pr.html_url,
          title: pr.title ?? "",
        };
        after(() =>
          announcePullRequest(opened).catch((error: unknown) => console.error("Slack agent: couldn't announce the PR", error)),
        );
      }
      return NextResponse.json({ received: true, runs: runs.length });
    }
    if (event === "issue_comment") {
      // The App's own review, posted: its run's check closes with it.
      // Its bot's login as GitHub has it now (the App can be renamed).
      after(async () =>
        finishCheckFromComment(payload, await appSlug(config), { openCheckOf, closeCheck: closeRunCheck }).catch(
          (error: unknown) => console.error("Couldn't close a run's check from its review", error),
        ),
      );
      return new NextResponse(null, { status: 204 });
    }
    if (event === "installation") {
      if (payload.action === "deleted") {
        dropInstallationToken(installationId);
        await forgetInstallation(installationId);
      } else if (payload.action === "suspend") {
        dropInstallationToken(installationId);
        await setInstallationSuspended(installationId, payload.installation?.suspended_at ?? new Date().toISOString());
      } else if (payload.action === "unsuspend") {
        await setInstallationSuspended(installationId, null);
      }
    } else if (event === "installation_repositories") {
      const selection = payload.repository_selection ?? payload.installation?.repository_selection;
      if (selection === "all" || selection === "selected") {
        await updateInstallation(installationId, { repositorySelection: selection });
      }
    } else if (event === "installation_target" && payload.action === "renamed") {
      const login = payload.account?.login ?? payload.installation?.account?.login;
      if (login) await updateInstallation(installationId, { accountLogin: login });
    }
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    // GitHub tries a failed delivery again.
    console.error(`GitHub webhook ${event} for installation ${installationId} failed`, error);
    return NextResponse.json({ error: "Couldn't record that." }, { status: 500 });
  }
}
