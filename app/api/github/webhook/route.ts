import { NextResponse } from "next/server";

import {
  forgetInstallation,
  installationOrg,
  setInstallationSuspended,
  updateInstallation,
} from "@/lib/db/github-installations";
import { githubAppConfig, webhookSignatureMatches } from "@/lib/github/app";

/** A body GitHub sends is far below this; anything bigger isn't GitHub's. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * The Outrunner GitHub App's webhook. Only what GitHub signed with the App's
 * webhook secret is read. It keeps the org's installations true to GitHub:
 * one uninstalled is forgotten, a suspended one is marked, a renamed account
 * is renamed, and a changed repository choice is recorded. An installation no
 * org keeps is GitHub's news to no one: answered, and left.
 */
export async function POST(request: Request) {
  const config = githubAppConfig();
  if (!config) return NextResponse.json({ error: "The GitHub App isn't set up here." }, { status: 503 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Too large." }, { status: 413 });
  }
  const raw = await request.text();
  if (!webhookSignatureMatches(config.webhookSecret, raw, request.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ error: "Bad signature." }, { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  let payload: {
    action?: string;
    installation?: { id?: number; account?: { login?: string }; repository_selection?: string };
    account?: { login?: string };
    repository_selection?: string;
  };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Not JSON." }, { status: 400 });
  }
  const installationId = payload.installation?.id;
  if (event === "ping" || typeof installationId !== "number") return new NextResponse(null, { status: 204 });

  try {
    if (!(await installationOrg(installationId))) return new NextResponse(null, { status: 204 });
    if (event === "installation") {
      if (payload.action === "deleted") await forgetInstallation(installationId);
      else if (payload.action === "suspend") await setInstallationSuspended(installationId, true);
      else if (payload.action === "unsuspend") await setInstallationSuspended(installationId, false);
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
