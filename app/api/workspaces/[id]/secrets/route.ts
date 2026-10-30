import { after, NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  defaultEnvironmentId,
  EnvironmentAccessError,
  EnvironmentConflictError,
  editEnvironmentSecrets,
} from "@/lib/db/environments";
import { EnvironmentRuleError } from "@/lib/environments/rules";
import { isSameOriginRequest } from "@/lib/http/guards";
import { settableEnv } from "@/lib/imports/settable-env";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";
import { agentChat, requestedChat } from "@/lib/session/chat-target";
import { provideAndSaveSecrets, SecretAnswer } from "@/lib/session/provide-secrets";
import { watchSent } from "@/lib/session/watch";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Answer the request for secrets a cloud session's agent is waiting on: the
 * form that stands in for the composer. The values go to the session's
 * agent, which keeps them for the session and tells the agent only their
 * names. They are also kept in the session's project, for its
 * next sessions. Nothing here logs or returns a value.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const parsed = SecretAnswer.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "That isn't an answer the request takes." }, { status: 400 });
  }
  // Accept the old checkbox field from clients opened before this deploy.
  // Project persistence is automatic, including when they send save: false.
  const answer = parsed.data;
  const values = answer.values ?? {};
  const refused = Object.keys(values).find((name) => !settableEnv(name) || !answer.keys.includes(name));
  if (refused) {
    return NextResponse.json({ error: `${refused} can't be set here.` }, { status: 400 });
  }

  const { id } = await context.params;
  const reach = await reachWorkspaceAgent(id, owner.id, {
    label: "Secrets",
    needsComputer: "Providing secrets requires a Runtime Computer provider.",
  });
  if (!reach.ok) return reach.response;
  const { workspace, agent, identity } = reach.reached;
  const named = await requestedChat(request, workspace);
  if (!named.ok) return named.response;
  const chat = agentChat(named.chat);

  // The session first: it checks the answer is to the request it's waiting
  // on, and nothing is saved for one that's over.
  try {
    const result = await provideAndSaveSecrets(answer, {
      provide: async (answer) => {
        await agent.provideSecrets(identity, answer, chat);
        // No longer waiting on the user: working again, and watched.
        if (!chat) after(() => watchSent(workspace.id, workspace.ownerId));
      },
      save: async (values) => {
        const environmentId = workspace.environmentId ?? (await defaultEnvironmentId(owner.id, workspace.projectId));
        if (!environmentId) throw new Error("no project");
        await editEnvironmentSecrets(owner.id, environmentId, { setEnv: values });
      },
      saveError: (error) => {
        const reason =
          error instanceof EnvironmentRuleError ||
          error instanceof EnvironmentConflictError ||
          error instanceof EnvironmentAccessError
            ? error.message
            : null;
        if (!reason) console.error(`Secrets: couldn't save to the project of ${workspace.id}`);
        return `The session has them, but they weren't saved to the project${reason ? `: ${reason}` : "."}`;
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AgentRequestError && error.error?.code === "CONFLICT") {
      return NextResponse.json({ error: error.error.message }, { status: 409 });
    }
    if (error instanceof AgentRequestError && error.error?.code === "INVALID_REQUEST") {
      return NextResponse.json({ error: error.error.message }, { status: 400 });
    }
    console.error(`Secrets: couldn't reach the session of ${workspace.id}`);
    return NextResponse.json({ error: "Couldn't send them to the session. Please try again." }, { status: 502 });
  }
}
