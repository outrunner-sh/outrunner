import { NextResponse } from "next/server";

import { answerBoxCall, boxScope, MAX_STATE_BYTES } from "@/lib/browser-sign-ins/sign-ins";
import { signInCrypto, signInStore } from "@/lib/browser-sign-ins/sign-ins.deps";
import { openAgentSecretOrNull } from "@/lib/db/computer-secret";
import { readCappedBody } from "@/lib/http/capped-body";
import { boxRequestValid } from "@/lib/runtime/git-credential";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** A save's body: the sign-ins, and the call around them. */
const MAX_BODY_BYTES = MAX_STATE_BYTES + 4 * 1024;

const PURPOSE = "browser-sign-ins";

/**
 * A box's desktop browser keeps its sign-ins between its person's sessions
 * in a project (lib/browser-sign-ins/sign-ins.ts): the box's agent saves them
 * here as they change, and a new session's box loads them for its browser's
 * first start (runtime-agent/internal/workspace/sign_ins.go). Signed with the
 * box's secret as a request for a GitHub token is
 * (app/api/runtime/git-credential), for this purpose alone. The body is
 * `{ op: "load" }` or `{ op: "save", state }`; whose sign-ins they are is the
 * box's own session's owner and project, read here, never the body's to say.
 * A project's shared box is answered 409: its sign-ins aren't kept. Neither
 * the body nor the answer is ever logged.
 */
export async function POST(request: Request) {
  const sandboxId = request.headers.get("x-outrunner-sandbox");
  // Read no further than a box's call goes: anyone can post here.
  const body = await readCappedBody(request, MAX_BODY_BYTES);
  if (!sandboxId || body === null) {
    return NextResponse.json({ error: "Not a box's request, or more than sign-ins are kept up to." }, { status: 400 });
  }
  const admin = createSupabaseAdminClient();
  const { data: computers, error } = await admin
    .from("runtime_computers")
    .select("id, owner_id, org_id, workspace_id, agent_secret")
    .eq("daytona_sandbox_id", sandboxId)
    .limit(5);
  if (error) {
    console.error("Browser sign-ins: couldn't read the box", error);
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

  let call: unknown;
  try {
    call = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  try {
    let session = null;
    if (computer.workspace_id) {
      const { data, error: sessionError } = await admin
        .from("workspaces")
        .select("id, owner_id, org_id, project_id")
        .eq("id", computer.workspace_id)
        .maybeSingle();
      if (sessionError) throw sessionError;
      if (data) session = { id: data.id, ownerId: data.owner_id, orgId: data.org_id, projectId: data.project_id };
    }
    const scope = boxScope(
      { id: computer.id, ownerId: computer.owner_id, orgId: computer.org_id, workspaceId: computer.workspace_id },
      session,
    );
    if (!scope) {
      return NextResponse.json({ error: "This computer's browser sign-ins aren't kept: it isn't one session's own." }, { status: 409 });
    }
    const answer = await answerBoxCall(scope, call, signInStore, signInCrypto, Date.now());
    return NextResponse.json(answer.body, { status: answer.status });
  } catch (failure) {
    // The failure only: a sign-in's value is never in it, nor the body.
    console.error(`Browser sign-ins: couldn't answer box ${computer.id}`, failure instanceof Error ? failure.message : failure);
    return NextResponse.json({ error: "Outrunner couldn't keep the browser's sign-ins. Try again." }, { status: 503 });
  }
}
