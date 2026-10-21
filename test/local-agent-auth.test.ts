import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { ResolvedAuth } from "@/lib/agents/resolve";
import { deliverLocalAgentAuth, LocalAgentAuthError, signInLocalAgent } from "@/lib/desktop/local-agent-auth";
import type { AgentCliStatus, LocalStatus } from "@/lib/desktop/local-runtime";

const KEY = { kind: "openai-api-key", token: "sk-proj-" + "o".repeat(40) } as const;

type Call = { path: string; body: unknown };

/** The Mac app, relaying agent requests: `refuse` makes it refuse them all
 *  (an app from before the auth route). */
function fakeApp({ refuse = false } = {}): Call[] {
  const calls: Call[] = [];
  (globalThis as Record<string, unknown>).window = {
    __RUNTIME_DESKTOP__: true,
    __TAURI__: {
      core: {
        invoke: (cmd: string, args: { path: string; body: unknown }) => {
          assert.equal(cmd, "local_agent_request");
          calls.push({ path: args.path, body: args.body });
          return refuse ? Promise.reject(new Error("not allowed")) : Promise.resolve(null);
        },
        Channel: class {},
      },
    },
  };
  return calls;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as Record<string, unknown>).window;
});

/** The server's answer to how the agent signs in. */
function server(answer: ResolvedAuth | { status: number; error: string; settingsHref?: string }) {
  globalThis.fetch = (async () =>
    "status" in answer
      ? new Response(JSON.stringify(answer), { status: answer.status })
      : new Response(JSON.stringify(answer))) as typeof fetch;
}

function status(codex: AgentCliStatus | null): LocalStatus {
  const claude = { path: "/bin/claude", loggedIn: true, method: null };
  return {
    claude: claude.path,
    claudeLoggedIn: true,
    ...(codex && { agents: { claude, codex } }),
  } as LocalStatus;
}
const INSTALLED = { path: "/bin/codex", loggedIn: true, method: "chatgpt" } as const;

test("a credential goes to the session; with none, a saved one is taken away", async () => {
  const calls = fakeApp();
  server({ method: "api-key", credential: KEY, picked: true });
  await deliverLocalAgentAuth("ws-1", "codex", true);
  server({ method: "local", credential: null, picked: true });
  await deliverLocalAgentAuth("ws-1", "codex", true);
  assert.deepEqual(calls, [
    { path: "/workspaces/ws-1/auth", body: KEY },
    { path: "/workspaces/ws-1/auth", body: { kind: "none" } },
  ]);
});

test("an app from before session credentials: nothing to take away is fine, a credential isn't", async () => {
  fakeApp({ refuse: true });
  server({ method: "local", credential: null, picked: false });
  await deliverLocalAgentAuth("ws-1", "claude", true);
  server({ method: "api-key", credential: KEY, picked: true });
  await assert.rejects(deliverLocalAgentAuth("ws-1", "codex", true));
});

test("a pick that can't run says where to fix it", async () => {
  fakeApp();
  server({ status: 409, error: "Save your OpenAI API key…", settingsHref: "/settings/providers?tab=codex&method=api-key" });
  await assert.rejects(signInLocalAgent("ws-1", "codex", status(INSTALLED), true), (error: unknown) => {
    assert.ok(error instanceof LocalAgentAuthError);
    assert.equal(error.settingsHref, "/settings/providers?tab=codex&method=api-key");
    return true;
  });
});

test("Codex must be on this Mac, even on an API key", async () => {
  const calls = fakeApp();
  server({ method: "api-key", credential: KEY, picked: true });
  await assert.rejects(signInLocalAgent("ws-1", "codex", status({ path: null, loggedIn: null, method: null }), true), /Install Codex/);
  await assert.rejects(signInLocalAgent("ws-1", "codex", status(null), true), /Update the Outrunner app/);
  assert.equal(calls.length, 0, "nothing handed over to a session that can't run");
  // On an API key, the Mac's own login doesn't matter.
  await signInLocalAgent("ws-1", "codex", status({ path: "/bin/codex", loggedIn: false, method: null }), true);
});

test("the Mac's own login, picked, must be signed in", async () => {
  fakeApp();
  server({ method: "chatgpt", credential: null, picked: true });
  await assert.rejects(
    signInLocalAgent("ws-1", "codex", status({ path: "/bin/codex", loggedIn: false, method: null }), true),
    (error: unknown) => error instanceof LocalAgentAuthError && error.settingsHref.endsWith("method=chatgpt"),
  );
  await signInLocalAgent("ws-1", "codex", status(INSTALLED), true);
});

test("the server is told whether the session needs the agent's own account", async () => {
  fakeApp();
  const sent: unknown[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ method: null, credential: null, picked: false }));
  }) as typeof fetch;
  await deliverLocalAgentAuth("ws-1", "claude", false);
  await deliverLocalAgentAuth("ws-1", "claude", true);
  assert.deepEqual(sent, [
    { agent: "claude", ownAccount: false },
    { agent: "claude", ownAccount: true },
  ]);
});
