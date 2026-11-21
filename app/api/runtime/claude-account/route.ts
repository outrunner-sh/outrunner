import { NextResponse } from "next/server";

import { answerLimit } from "@/lib/claude/accounts";
import { claudeAccountStore, loadClaudeAccounts } from "@/lib/claude/accounts.deps";
import { open } from "@/lib/crypto/secret-box";
import { openAgentSecretOrNull } from "@/lib/db/computer-secret";
import { settleClaudeSlot } from "@/lib/db/credentials";
import { readCappedBody } from "@/lib/http/capped-body";
import { boxRequestValid } from "@/lib/runtime/git-credential";
import { boxHostsSession } from "@/lib/runtime/box-session";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** A call's body: a session id, a hash and a time. */
const MAX_BODY_BYTES = 4 * 1024;

const PURPOSE = "claude-account";

/**
 * A session on its user's own Claude subscription hit its usage limit
 * (runtime-agent/internal/workspace/claude_account.go): its box asks which
 * of the user's Claude accounts to carry on with (lib/claude/accounts.ts).
 * Signed with the box's secret as a request for a GitHub token is
 * (app/api/runtime/git-credential), for this purpose alone. The body is
 * `{ workspace, tokenSha256, resetsAt? }`: a session on this box, the box's
 * user's, in its org, and the hash of the token it's on, never the token.
 * The account with that token is marked at its limit until `resetsAt` (an
 * hour without one), and the answer is the next account's token, name and
 * the limited one's name; or `{ token: null, firstReset }` when none can run.
 */
export async function POST(request: Request) {
  const sandboxId = request.headers.get("x-outrunner-sandbox");
  // Read no further than a box's call goes: anyone can post here.
  const body = await readCappedBody(request, MAX_BODY_BYTES);
  if (!sandboxId || body === null) {
    return NextResponse.json({ error: "Not a box's request." }, { status: 400 });
  }
  const admin = createSupabaseAdminClient();
  const { data: computers, error } = await admin
    .from("runtime_computers")
    .select("id, owner_id, org_id, workspace_id, agent_secret")
    .eq("daytona_sandbox_id", sandboxId)
    .limit(5);
  if (error) {
    console.error("Claude account: couldn't read the box", error);
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

  let call: { workspace?: unknown; tokenSha256?: unknown; resetsAt?: unknown };
  try {
    call = JSON.parse(body) as typeof call;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  if (typeof call.workspace !== "string" || typeof call.tokenSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(call.tokenSha256)) {
    return NextResponse.json({ error: "Name the session and the hash of its token." }, { status: 400 });
  }
  const resetsAt = typeof call.resetsAt === "string" && call.resetsAt.length <= 40 ? call.resetsAt : null;

  try {
    // The session must be one on this box, the box's user's, in its org: a
    // box's agent speaks for its own sessions alone.
    const { data: workspace, error: workspaceError } = await admin
      .from("workspaces")
      .select("id, owner_id, org_id, computer_id")
      .eq("id", call.workspace)
      .maybeSingle();
    if (workspaceError && workspaceError.code !== "22P02") throw workspaceError;
    if (
      !workspace ||
      !boxHostsSession({ id: computer.id, workspaceId: computer.workspace_id }, { id: workspace.id, computerId: workspace.computer_id }) ||
      workspace.owner_id !== computer.owner_id ||
      workspace.org_id !== computer.org_id
    ) {
      return NextResponse.json({ error: "That session isn't this computer's." }, { status: 404 });
    }

    const userId = workspace.owner_id;
    await settleClaudeSlot(userId);
    const accounts = await loadClaudeAccounts(userId);
    if (!accounts || accounts.length === 0) return NextResponse.json({ token: null, from: null, firstReset: null });
    const answer = await answerLimit(claudeAccountStore(userId), { tokenSha256: call.tokenSha256, resetsAt, now: Date.now() }, open);
    console.info(
      answer.token
        ? `Claude account: session ${workspace.id} moves from ${answer.from ?? "an unknown account"} to ${answer.label}`
        : `Claude account: session ${workspace.id} hit its limit on ${answer.from ?? "an unknown account"}; no other account can run`,
    );
    return NextResponse.json(answer);
  } catch (error) {
    console.error("Claude account: couldn't pick the next account", error);
    return NextResponse.json({ error: "Outrunner couldn't pick another Claude account. Try again." }, { status: 503 });
  }
}
