import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import { AGENT_FEATURE_EDITOR } from "@/lib/runtime/agent-protocol";
import { requireFeature } from "@/lib/runtime/box-features";
import { OutdatedComputerError } from "@/lib/runtime/session-auth";
import { boxUpgrade } from "@/lib/runtime/session-environment";
import { opensInBrowser } from "@/lib/runtime/types";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";

type RouteContext = { params: Promise<{ id: string }> };

/** How long an editor link works: a working day. Opening it again mints a new one. */
const EDITOR_LINK_TTL_SECONDS = 8 * 60 * 60;

/**
 * Open VS Code in the browser on a cloud session: the agent has code-server
 * running on the session's box, and the owner gets a link to it, on the
 * session's folder. While it is still starting (the first open on a box
 * installs it), the answer is 202 `{ starting: true }`, to ask again. The link carries its own credential (the provider's
 * signed preview URL), so it goes to the owner alone, as the terminal's does.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }

  const { id } = await context.params;
  const reach = await reachWorkspaceAgent(id, owner.id, {
    label: "Editor",
    needsComputer: "The editor runs on Outrunner's cloud computers.",
  });
  if (!reach.ok) return reach.response;
  const { workspace, provider, sandboxId, secret, agent, identity } = reach.reached;

  // Before the agent is asked: where no browser link can be made, nothing is
  // installed or started for it.
  if (!opensInBrowser(workspace.provider)) {
    return NextResponse.json({ error: "The editor opens on Outrunner's Daytona sandboxes only." }, { status: 409 });
  }

  try {
    let editor;
    try {
      editor = await agent.openEditor(identity);
    } catch (error) {
      // No such route: an agent from before the editor, brought up to this
      // one's, then asked again. Asked only then, not on every poll.
      if (!(error instanceof AgentRequestError && error.status === 404 && !error.error)) throw error;
      await requireFeature(
        {
          features: async () => (await agent.health(identity)).features ?? [],
          upgrade: boxUpgrade(provider, sandboxId, secret, owner.id),
        },
        AGENT_FEATURE_EDITOR,
        "open the editor",
      );
      editor = await agent.openEditor(identity);
    }
    // Still being installed or started: the button asks again.
    if (!editor) return NextResponse.json({ starting: true }, { status: 202 });
    const base = await provider.browserUrl(sandboxId, editor.port, EDITOR_LINK_TTL_SECONDS);
    if (!base) {
      return NextResponse.json({ error: "This session's sandbox can't open the editor in a browser." }, { status: 409 });
    }
    const url = new URL(base);
    url.searchParams.set("folder", editor.folder);
    return NextResponse.json({ url: url.toString() });
  } catch (error) {
    if (error instanceof OutdatedComputerError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof AgentRequestError && error.status === 404) {
      return NextResponse.json({ error: "This session's files aren't on its computer any more." }, { status: 410 });
    }
    console.error(`Editor: failed for ${workspace.id}`, error);
    return NextResponse.json({ error: "Couldn't open the editor. Please try again." }, { status: 502 });
  }
}
