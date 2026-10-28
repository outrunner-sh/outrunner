import { after, NextResponse } from "next/server";

import { rerunRun, startRun } from "@/lib/automations/runs";
import { startDeps } from "@/lib/automations/start-deps";
import { recordRuns, reopenRun, rerunTarget } from "@/lib/db/automation-runs";
import { getPullRequest, githubAppConfig, installationToken } from "@/lib/github/app";
import { isUuid } from "@/lib/ids";
import { orgCaller } from "@/lib/orgs/routes";

type Params = { params: Promise<{ id: string; runId: string }> };

/** Run a run that failed or didn't start again, on its pull request's head
 *  as it is now: the org's admins may. Its session starts after the answer,
 *  as the webhook's runs do. */
export async function POST(request: Request, { params }: Params) {
  const { id, runId } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  if (!isUuid(runId)) return NextResponse.json({ error: "No such run." }, { status: 404 });
  const config = githubAppConfig();
  if (!config) return NextResponse.json({ error: "The GitHub App isn't set up on this deployment." }, { status: 503 });

  try {
    const rerun = await rerunRun(
      id,
      runId,
      {
        rerunTarget,
        pullRequest: async (installationId, repoFullName, number) =>
          getPullRequest(await installationToken(config, installationId), repoFullName, number),
        reopenRun,
        recordRuns,
      },
      config.slug,
    );
    if (!rerun.ok) return NextResponse.json({ error: rerun.error }, { status: rerun.status });
    after(() => startRun(rerun.run, startDeps()));
    return NextResponse.json({ runId: rerun.run.runId });
  } catch (error) {
    console.error(`Couldn't run ${runId} again`, error);
    return NextResponse.json({ error: "Couldn't run it again. Try again." }, { status: 502 });
  }
}
