import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentClient, AgentRequestError, type AgentTarget } from "@/lib/runtime/agent-client";
import { verifyRuntimeToken } from "@/lib/runtime/runtime-token";

const target: AgentTarget = {
  controlBaseUrl: "https://8080-sbx.daytonaproxy01.net",
  controlHeaders: { "x-daytona-preview-token": "dt-preview-token" },
  wsBaseUrl: "https://8080-signed.daytonaproxy01.net",
  secret: "computer-secret",
};

const identity = {
  workspaceId: "ws-1",
  projectId: "p-1",
  computerId: "c-1",
  userId: "u-1",
};

test("createWorkspace posts a valid body with a verifiable Runtime token", async () => {
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenHeaders = init.headers as Record<string, string>;
    return new Response(JSON.stringify({ worktree: "/home/runtime/ws/ws-1" }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  const client = new AgentClient(target, fakeFetch);
  const out = await client.createWorkspace(
    { workspaceId: "ws-1", repoFullName: "acme/app", branch: "feat/x", baseBranch: "main" },
    identity,
  );

  assert.equal(out.worktree, "/home/runtime/ws/ws-1");
  assert.equal(seenUrl, "https://8080-sbx.daytonaproxy01.net/workspaces");
  const headers = seenHeaders;
  // The Daytona preview header and a valid Runtime token must both be present.
  assert.equal(headers["x-daytona-preview-token"], "dt-preview-token");
  const bearer = headers["authorization"].replace("Bearer ", "");
  assert.equal(verifyRuntimeToken(bearer, target.secret).workspaceId, "ws-1");
});

test("a non-2xx error envelope is surfaced as a typed error", async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ error: { code: "WORKSPACE_NOT_FOUND", message: "gone" } }),
      { status: 404 },
    )) as unknown as typeof fetch;

  const client = new AgentClient(target, fakeFetch);
  await assert.rejects(
    () => client.startWorkspace(identity),
    /WORKSPACE_NOT_FOUND: gone/,
  );
});

test("archiveWorkspace posts the archive body and parses the manifest", async () => {
  const manifest = {
    version: 1,
    workspaceId: "ws-1",
    runtimeVersion: "dev",
    claudeVersion: "claude-code-1.2.3",
    sessionId: "sess-1",
    conversation: "conversation.jsonl",
    cast: "session.cast",
    tree: { kind: "git-bundle+patch", bundle: "worktree.bundle", patch: "uncommitted.patch" },
    summary: "summary.json",
    checksums: {},
    sizes: {},
    startedAt: "2026-08-06T00:00:00Z",
    archivedAt: "2026-08-06T00:05:00Z",
    lastCommit: null,
    lastMessage: null,
    tokenUsage: {},
    changedFiles: 0,
  };

  let seenUrl = "";
  let seenBody: unknown = null;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenBody = JSON.parse(init.body as string);
    return new Response(JSON.stringify(manifest), { status: 200 });
  }) as unknown as typeof fetch;

  const uploads = (["conversation", "cast", "bundle", "patch", "summary", "manifest"] as const).map(
    (artifact) => ({ artifact, url: `https://storage.example/upload/${artifact}?token=t` }),
  );
  const client = new AgentClient(target, fakeFetch);
  const out = await client.archiveWorkspace(identity, {
    archivedAt: "2026-08-06T00:05:00Z",
    uploads,
  });

  assert.equal(seenUrl, "https://8080-sbx.daytonaproxy01.net/workspaces/ws-1/archive");
  assert.deepEqual(seenBody, { archivedAt: "2026-08-06T00:05:00Z", uploads });
  assert.equal(out.workspaceId, "ws-1");
  assert.equal(out.tree.kind, "git-bundle+patch");
});

test("archiveWorkspace rejects a request missing an artifact upload", async () => {
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const client = new AgentClient(target, fakeFetch);
  await assert.rejects(() =>
    client.archiveWorkspace(identity, {
      archivedAt: "2026-08-06T00:05:00Z",
      uploads: [{ artifact: "manifest", url: "https://storage.example/m?token=t" }],
    }),
  );
  assert.equal(called, false);
});

test("archiveWorkspace rejects a malformed manifest response", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ version: 1, workspaceId: "ws-1" }), {
      status: 200,
    })) as unknown as typeof fetch;

  const client = new AgentClient(target, fakeFetch);
  await assert.rejects(() =>
    client.archiveWorkspace(identity, {
      archivedAt: "2026-08-06T00:05:00Z",
      uploads: (["conversation", "cast", "bundle", "patch", "summary", "manifest"] as const).map(
        (artifact) => ({ artifact, url: `https://storage.example/${artifact}?token=t` }),
      ),
    }),
  );
});

test("restoreWorkspace posts branch, sessionId, and download URLs", async () => {
  let seenUrl = "";
  let seenBody: unknown = null;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenBody = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ result: "ws-1" }), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new AgentClient(target, fakeFetch);
  await client.restoreWorkspace(identity, {
    branch: "feat/x",
    baseBranch: "main",
    sessionId: "sess-1",
    downloads: [
      { artifact: "bundle", url: "https://storage.example/b?token=t" },
      { artifact: "patch", url: "https://storage.example/p?token=t" },
      { artifact: "conversation", url: "https://storage.example/c?token=t" },
    ],
  });

  assert.equal(seenUrl, "https://8080-sbx.daytonaproxy01.net/workspaces/ws-1/restore");
  assert.deepEqual(seenBody, {
    branch: "feat/x",
    baseBranch: "main",
    sessionId: "sess-1",
    downloads: [
      { artifact: "bundle", url: "https://storage.example/b?token=t" },
      { artifact: "patch", url: "https://storage.example/p?token=t" },
      { artifact: "conversation", url: "https://storage.example/c?token=t" },
    ],
  });
});

test("restoreWorkspace rejects an invalid request body before calling the agent", async () => {
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const client = new AgentClient(target, fakeFetch);
  await assert.rejects(() =>
    client.restoreWorkspace(identity, {
      branch: "",
      sessionId: "s",
      downloads: [],
    }),
  );
  assert.equal(called, false);
});

test("ptyUrl builds a wss signed-preview URL carrying a Runtime token", () => {
  const client = new AgentClient(target);
  const url = new URL(client.ptyUrl(identity));
  assert.equal(url.protocol, "wss:");
  assert.equal(url.host, "8080-signed.daytonaproxy01.net");
  assert.equal(url.pathname, "/pty");
  assert.equal(
    verifyRuntimeToken(url.searchParams.get("token")!, target.secret).workspaceId,
    "ws-1",
  );
});

test("setModel posts the switch to the workspace's model route", async () => {
  let seenUrl = "";
  let seenBody: unknown;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ result: "z-ai/glm-5.3" }), { status: 200 });
  }) as unknown as typeof fetch;

  await new AgentClient(target, fakeFetch).setModel(identity, {
    model: "z-ai/glm-5.3",
    gateway: "openrouter",
    token: "sk-or-v1-test-key-0123456789",
  });
  assert.equal(seenUrl, "https://8080-sbx.daytonaproxy01.net/workspaces/ws-1/model");
  assert.deepEqual(seenBody, { model: "z-ai/glm-5.3", gateway: "openrouter", token: "sk-or-v1-test-key-0123456789" });
});

test("an agent refusal keeps its status and error envelope", async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ error: { code: "CONFLICT", message: "Claude is mid-turn; switch models once it has finished" } }),
      { status: 409 },
    )) as unknown as typeof fetch;

  const error = await new AgentClient(target, fakeFetch).setModel(identity, { model: "opus" }).catch((e: unknown) => e);
  assert.ok(error instanceof AgentRequestError);
  assert.equal(error.status, 409);
  assert.equal(error.error?.code, "CONFLICT");
  assert.match(error.message, /agent CONFLICT: Claude is mid-turn/);
});

test("an answer that isn't the agent's envelope has a status and no envelope", async () => {
  // Go's mux, for a route an older agent doesn't have.
  const fakeFetch = (async () => new Response("404 page not found\n", { status: 404 })) as unknown as typeof fetch;

  const error = await new AgentClient(target, fakeFetch).setModel(identity, { model: "opus" }).catch((e: unknown) => e);
  assert.ok(error instanceof AgentRequestError);
  assert.equal(error.status, 404);
  assert.equal(error.error, undefined);
});

test("activity asks about the whole box on the listing token", async () => {
  let seenUrl = "";
  let seenAuth = "";
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenAuth = (init.headers as Record<string, string>).authorization;
    return new Response(JSON.stringify({ lastActivity: "2026-10-17T10:02:00Z", turnInProgress: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const box = { projectId: identity.projectId, computerId: identity.computerId, userId: identity.userId };
  const activity = await new AgentClient(target, fakeFetch).activity(box);
  assert.deepEqual(activity, { lastActivity: "2026-10-17T10:02:00Z", turnInProgress: true });
  assert.equal(seenUrl, "https://8080-sbx.daytonaproxy01.net/activity");
  const claims = verifyRuntimeToken(seenAuth.replace(/^Bearer /, ""), target.secret);
  assert.equal(claims.workspaceId, "*");
  assert.equal(claims.computerId, "c-1");
});

test("an agent from before /activity answers 404, as an AgentRequestError", async () => {
  const fakeFetch = (async () => new Response("404 page not found", { status: 404 })) as unknown as typeof fetch;
  const box = { projectId: identity.projectId, computerId: identity.computerId, userId: identity.userId };
  await assert.rejects(new AgentClient(target, fakeFetch).activity(box), (error: unknown) => {
    assert.ok(error instanceof AgentRequestError);
    assert.equal(error.status, 404);
    return true;
  });
});

test("openEditor says where the editor is, or null while it starts", async () => {
  const answers = [
    new Response(JSON.stringify({ result: "starting" }), { status: 202 }),
    new Response(JSON.stringify({ port: 8443, folder: "/home/daytona/workspaces/ws-1" }), { status: 200 }),
  ];
  const urls: string[] = [];
  const fakeFetch = (async (url: string) => {
    urls.push(url);
    return answers.shift()!;
  }) as unknown as typeof fetch;
  const client = new AgentClient(target, fakeFetch);

  assert.equal(await client.openEditor(identity), null);
  assert.deepEqual(await client.openEditor(identity), { port: 8443, folder: "/home/daytona/workspaces/ws-1" });
  assert.deepEqual(urls, [
    "https://8080-sbx.daytonaproxy01.net/workspaces/ws-1/editor",
    "https://8080-sbx.daytonaproxy01.net/workspaces/ws-1/editor",
  ]);
});

test("listPorts reads the box's servers", async () => {
  const fakeFetch = (async (url: string) => {
    assert.equal(url, "https://8080-sbx.daytonaproxy01.net/workspaces/ws-1/ports");
    return new Response(JSON.stringify({ ports: [{ port: 3000, process: "node" }, { port: 5173 }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const ports = await new AgentClient(target, fakeFetch).listPorts(identity);
  assert.deepEqual(ports, [{ port: 3000, process: "node" }, { port: 5173 }]);
});
