import { NextResponse } from "next/server";

import { ownerFromUser } from "@/lib/auth/owner";
import { openAgentSecretOrNull } from "@/lib/db/computer-secret";
import { memoryStore } from "@/lib/db/memories";
import { optionalEnv } from "@/lib/env";
import { learningActor, learningDeps } from "@/lib/learnings/actions.deps";
import { boxRequestValid } from "@/lib/runtime/git-credential";
import { renameBranchDeps } from "@/lib/session/rename-branch.deps";
import { callSessionTool } from "@/lib/session-tools/tools";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** A call's body: a tool's arguments at most. */
const MAX_BODY_BYTES = 64 * 1024;

const PURPOSE = "session-tools";

/**
 * A session's own command (`outrunner-session …`, lib/session-tools/tools.ts),
 * passed on by its box's agent, signed with the box's secret as a request
 * for a GitHub token is (app/api/runtime/git-credential), but for this
 * purpose alone. The body names the session, `{ workspace, tool, args }`:
 * it must be one of the box's user's, in the box's org, and the tool acts as
 * that user there. Answers `{ text }` for the agent to read, or `{ error }`.
 */
export async function POST(request: Request) {
  const sandboxId = request.headers.get("x-outrunner-sandbox");
  const body = await request.text();
  if (!sandboxId || body.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Not a box's request." }, { status: 400 });
  }
  const admin = createSupabaseAdminClient();
  const { data: computers, error } = await admin
    .from("runtime_computers")
    .select("id, owner_id, org_id, agent_secret")
    .eq("daytona_sandbox_id", sandboxId)
    .limit(5);
  if (error) {
    console.error("Session tools: couldn't read the box", error);
    return NextResponse.json({ error: "Outrunner couldn't look up this computer. Try again." }, { status: 503 });
  }
  const signed = {
    sandboxId,
    timestamp: request.headers.get("x-outrunner-timestamp"),
    signature: request.headers.get("x-outrunner-signature"),
    body,
  };
  const computer = (computers ?? []).find((c) => {
    const secret = openAgentSecretOrNull(c.agent_secret, c.id);
    return secret !== null && boxRequestValid(PURPOSE, secret, signed);
  });
  if (!computer) return NextResponse.json({ error: "Bad signature." }, { status: 401 });

  let call: { workspace?: unknown; tool?: unknown; args?: unknown };
  try {
    call = JSON.parse(body) as typeof call;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const args = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? (call.args as Record<string, unknown>) : {};
  if (typeof call.workspace !== "string" || typeof call.tool !== "string") {
    return NextResponse.json({ error: "Name the session and the tool." }, { status: 400 });
  }

  try {
    // The session must be the box's user's, in its org: a box's agent speaks
    // for its own user's sessions alone.
    const { data: workspace, error: workspaceError } = await admin
      .from("workspaces")
      .select("id, owner_id, org_id")
      .eq("id", call.workspace)
      .maybeSingle();
    if (workspaceError && workspaceError.code !== "22P02") throw workspaceError;
    if (!workspace || workspace.owner_id !== computer.owner_id || workspace.org_id !== computer.org_id) {
      return NextResponse.json({ error: "That session isn't this computer's." }, { status: 404 });
    }
    const { data: user } = await admin.auth.admin.getUserById(workspace.owner_id);
    const actor = user.user ? ownerFromUser(user.user) : "system";
    const answer = await callSessionTool(
      { userId: workspace.owner_id, orgId: workspace.org_id, workspaceId: workspace.id },
      call.tool,
      args,
      {
        actor: learningActor,
        learnings: learningDeps(actor),
        memory: memoryStore,
        renameBranch: renameBranchDeps(),
        base: optionalEnv("RUNTIME_BASE_URL") ?? new URL(request.url).origin,
      },
    );
    return NextResponse.json(answer.error ? { error: answer.error } : { text: answer.text }, { status: answer.status });
  } catch (cause) {
    console.error(`Session tools: ${String(call.tool)} failed for box ${sandboxId}`, cause);
    return NextResponse.json({ error: "Outrunner couldn't do that. It logged why; try again." }, { status: 502 });
  }
}
