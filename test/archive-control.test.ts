import assert from "node:assert/strict";
import { test } from "node:test";

import { archiveOffer, archiveSession } from "@/lib/session/archive-control";
import type { WorkspaceStatus } from "@/lib/runtime/types";

test("Archive can be pressed only from the statuses the lifecycle route archives from", () => {
  const pressable = (status: WorkspaceStatus) => archiveOffer({ status, provider: "daytona" })?.can ?? null;
  assert.equal(pressable("ready"), true);
  assert.equal(pressable("idle"), true);
  // Asleep: the agent stops a session before saving it, so none need wake.
  assert.equal(pressable("suspended"), true);
  for (const status of [
    "creating",
    "provisioning",
    "suspending",
    "resuming",
    "destroying",
    "archiving",
    "restoring",
    "failed",
  ] as const) {
    assert.equal(pressable(status), false, status);
  }
  // Nothing left to archive: no control at all.
  assert.equal(pressable("archived"), null);
  assert.equal(pressable("destroyed"), null);
});

test("a status this build doesn't know is not offered", () => {
  assert.equal(archiveOffer({ status: "hibernating" as WorkspaceStatus, provider: "daytona" }), null);
});

test("a disabled Archive says why", () => {
  assert.deepEqual(archiveOffer({ status: "provisioning", provider: "daytona" }), {
    can: false,
    why: "It can be archived once its setup finishes.",
  });
});

test("Archive is offered only on a Runtime Computer, which has a Snapshot to restore from", () => {
  for (const provider of ["daytona", "neev", "user-daytona", "user-modal"] as const) {
    assert.deepEqual(archiveOffer({ status: "ready", provider }), { can: true }, provider);
  }
  for (const provider of ["local", "modal"] as const) {
    assert.equal(archiveOffer({ status: "ready", provider }), null, provider);
  }
});

test("an archive asks the lifecycle route, and a refusal says why", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const answering = (status: number, body: unknown) =>
    (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;

  assert.equal(await archiveSession("ws-1", answering(200, { workspace: { id: "ws-1", status: "archived" } })), null);
  assert.deepEqual(calls, [{ url: "/api/workspaces/ws-1/lifecycle", body: { action: "archive" } }]);
  // Archived without its files, its box out of reach: that's said.
  const note = "Archived without its files: its box couldn't be reached.";
  assert.equal(await archiveSession("ws-5", answering(200, { workspace: { id: "ws-5", status: "archived" }, note })), note);

  await assert.rejects(
    archiveSession("ws-2", answering(409, { error: "Only an active workspace can be archived." })),
    { message: "Only an active workspace can be archived." },
  );
  // A body without a sentence still says something.
  await assert.rejects(archiveSession("ws-3", answering(502, { nope: true })), {
    message: "Could not archive this session. Please try again.",
  });
  const offline = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
  await assert.rejects(archiveSession("ws-4", offline), {
    message: "Could not reach Outrunner. Check your connection and try again.",
  });
});

test("an archive refusal shows the actionable pending-handoff reason", async () => {
  const reason = "chat c1 has an unspent fork handoff; send its first prompt or delete the chat before archiving";
  await assert.rejects(archiveSession("w", (async () => Response.json({ error: reason }, { status: 502 })) as typeof fetch), { message: reason });
});
