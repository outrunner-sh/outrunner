import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test, type TestContext } from "node:test";

import { AgentClient, AgentRequestError } from "@/lib/runtime/agent-client";
import { RuntimeAgentUnavailableError, withRuntimeAgentRecovery } from "@/lib/runtime/agent-recovery";
import type { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { SNAPSHOT_ARTIFACTS, type SnapshotArtifact } from "@/lib/runtime/snapshot/manifest";
import { saveForArchive } from "@/lib/session/archive-save";

const identity = { userId: "owner", computerId: "computer", workspaceId: "ship", projectId: "project" };
const capture = { archivedAt: "2026-10-29T00:00:00Z", uploads: (Object.keys(SNAPSHOT_ARTIFACTS) as SnapshotArtifact[]).map((artifact) => ({ artifact, url: `https://storage.test/${artifact}` })) };

async function endpoint(t: TestContext, respond: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(respond);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { controlBaseUrl: `http://127.0.0.1:${address.port}`, wsBaseUrl: "ws://unused", controlHeaders: {}, secret: "fixture-secret" };
}

function recovery(target: Awaited<ReturnType<typeof endpoint>>, upgrade?: () => Promise<void>) {
  const agent = new AgentClient(target);
  return { provider: { agentTarget: async () => target } as unknown as ComputerRuntimeProvider, sandboxId: "test-box", secret: target.secret, agent, identity, workspaceId: identity.workspaceId, upgrade };
}

function saving(input: ReturnType<typeof recovery>, requireSnapshot = false) {
  return saveForArchive({
    bringBack: async () => {}, connect: async () => input.agent,
    capture: async () => (await withRuntimeAgentRecovery(input, (current) => current.archiveWorkspace(identity, capture))).result,
  }, { requireSnapshot });
}

for (const status of [502, 503, 504]) {
  test(`a plain proxy ${status} after failed redeploy does not block manual archive`, async (t) => {
    const target = await endpoint(t, (_req, res) => { res.writeHead(status); res.end("Sandbox is not reachable"); });
    const input = recovery(target, async () => { throw new Error("Sandbox test-box is not running"); });
    await assert.rejects(input.agent.health(identity), (error) => error instanceof AgentRequestError && error.status === status && !error.error);
    const save = await saving(input);
    assert.equal(save.saved, false);
    if (!save.saved) {
      assert.ok(save.cause instanceof RuntimeAgentUnavailableError);
      assert.match((save.cause.cause as Error).message, /not running/);
    }
    await assert.rejects(saving(input, true), RuntimeAgentUnavailableError, "background archive still requires a Snapshot");
  });
}

test("a redeployed agent that still cannot answer and a provider lookup failure remain availability failures", async (t) => {
  const target = await endpoint(t, (_req, res) => { res.writeHead(503); res.end("proxy unavailable"); });
  assert.equal((await saving(recovery(target, async () => {}))).saved, false);
  assert.equal((await saving(recovery(target))).saved, false, "no in-place upgrade still reports unavailability");
  const missing = recovery(target, async () => { throw new Error("Sandbox test-box not found"); });
  missing.provider.agentTarget = async () => { throw new Error("Sandbox test-box not found"); };
  assert.equal((await saving(missing)).saved, false);
});

test("a reachable capture/upload error is kept even if health fails afterwards", async (t) => {
  let upgrades = 0;
  const target = await endpoint(t, (req, res) => {
    res.writeHead(req.url === "/health" ? 503 : 500, { "content-type": "application/json" });
    res.end(req.url === "/health" ? "proxy unavailable" : JSON.stringify({ error: { code: "INTERNAL", message: "upload failed: storage unavailable" } }));
  });
  await assert.rejects(saving(recovery(target, async () => { upgrades++; })), (error) => error instanceof AgentRequestError && error.error?.message.includes("upload failed") === true);
  assert.equal(upgrades, 0, "a real agent's application error must not be converted to unavailability");
});

test("a recovered agent's upload failure and a healthy agent's missing endpoint preserve the session", async (t) => {
  let recovered = false;
  const target = await endpoint(t, (req, res) => {
    if (!recovered) { res.writeHead(503); res.end("proxy unavailable"); return; }
    res.writeHead(req.url === "/health" ? 200 : 500, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/health" ? { status: "ok" } : { error: { code: "INTERNAL", message: "tar failed" } }));
  });
  await assert.rejects(saving(recovery(target, async () => { recovered = true; })), (error) => error instanceof AgentRequestError && error.error?.message === "tar failed");
  const old = await endpoint(t, (req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404);
    res.end(req.url === "/health" ? JSON.stringify({ status: "ok" }) : "unknown endpoint");
  });
  await assert.rejects(saving(recovery(old)), (error) => error instanceof AgentRequestError && error.status === 404);
});

test("a stale endpoint is refreshed and saved without redeploying a healthy agent", async (t) => {
  const stale = await endpoint(t, (_req, res) => { res.writeHead(503); res.end("stale proxy"); });
  const fresh = await endpoint(t, (_req, res) => { res.end(JSON.stringify({ status: "ok" })); });
  let upgrades = 0;
  const input = recovery(stale, async () => { upgrades++; });
  input.provider.agentTarget = async () => fresh;
  const result = await withRuntimeAgentRecovery(input, (agent) => agent.health(identity));
  assert.equal(result.result.status, "ok");
  assert.equal(upgrades, 0);
});

test("an agent's auth response is not proof that its box is unreachable", async (t) => {
  const target = await endpoint(t, (req, res) => {
    res.writeHead(req.url === "/health" ? 401 : 503);
    res.end(req.url === "/health" ? JSON.stringify({ error: { code: "UNAUTHORIZED", message: "wrong secret" } }) : "proxy error");
  });
  await assert.rejects(saving(recovery(target)), (error) => error instanceof AgentRequestError && error.status === 503);
});

test("a malformed health answer is not enough evidence to discard saveable files", async (t) => {
  const target = await endpoint(t, (req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 503);
    res.end(req.url === "/health" ? JSON.stringify({ status: "unexpected" }) : "proxy error");
  });
  await assert.rejects(saving(recovery(target)), (error) => error instanceof AgentRequestError && error.status === 503);
});
