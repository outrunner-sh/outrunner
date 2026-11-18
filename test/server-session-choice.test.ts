import assert from "node:assert/strict";
import { test } from "node:test";

import { OUTRUNNER_MODELS } from "@/lib/runtime/session-models";
import type { SessionRequest } from "@/lib/session/create-cloud-session";
import type { ServerSessionResult } from "@/lib/session/server-session";
import { startOnChoice, startOnChosen } from "@/lib/session/server-session-choice";

const start = { prompt: "Review it.", branch: "review/7" };
const outrunner = { provider: "outrunner", model: OUTRUNNER_MODELS[0].id, prompt: "Review it.", branch: "review/7" };
const own = { prompt: "Review it.", branch: "review/7" };
const refused = (errorMessage: string): ServerSessionResult => ({ workspaceId: null, status: "refused", errorMessage });

/** An attempt answering each request in turn, and what it was asked. */
function attempts(...results: ServerSessionResult[]) {
  const asked: SessionRequest[] = [];
  const attempt = async (request: SessionRequest) => {
    asked.push(request);
    const result = results.shift();
    assert.ok(result, "asked once too often");
    return result;
  };
  return { asked, attempt };
}

test("off, it starts once on Outrunner's models", async () => {
  const { asked, attempt } = attempts({ workspaceId: "w1", status: "ready" });
  assert.deepEqual(await startOnChosen(start, attempt), { workspaceId: "w1", status: "ready" });
  assert.deepEqual(asked, [outrunner]);
});

test("on, it starts on the user's own default, naming no model", async () => {
  const { asked, attempt } = attempts({ workspaceId: "w1", status: "ready" });
  assert.deepEqual(await startOnChosen({ ...start, onHarness: true }, attempt), { workspaceId: "w1", status: "ready" });
  assert.deepEqual(asked, [own]);
});

test("on, a refusal starts it on Outrunner's models instead, saying why", async () => {
  const { asked, attempt } = attempts(refused("Connect Claude to start a session on your Claude account."), { workspaceId: "w2", status: "ready" });
  const result = await startOnChosen({ ...start, onHarness: true }, attempt);
  assert.deepEqual(asked, [own, outrunner]);
  assert.deepEqual(result, {
    workspaceId: "w2",
    status: "ready",
    fellBack: "Ran on Outrunner's models: it couldn't start on your own. Connect Claude to start a session on your Claude account.",
  });
});

test("on, a session made that failed is that session's, never a second one", async () => {
  const { asked, attempt } = attempts({ workspaceId: "w1", status: "failed", errorMessage: "Its box didn't start." });
  assert.deepEqual(await startOnChosen({ ...start, onHarness: true }, attempt), {
    workspaceId: "w1",
    status: "failed",
    errorMessage: "Its box didn't start.",
  });
  assert.equal(asked.length, 1);
});

test("on, refused on both, it answers Outrunner's refusal, with no fallback claimed", async () => {
  const { attempt } = attempts(refused("Connect Claude."), refused("Outrunner's models aren't metered per user on this server."));
  assert.deepEqual(
    await startOnChosen({ ...start, onHarness: true }, attempt),
    refused("Outrunner's models aren't metered per user on this server."),
  );
});

const choice = { provider: "claude", id: "opus", effort: "max" };
const chosen = { provider: "claude", model: "opus", effort: "max", prompt: "Review it.", branch: "review/7" };

test("a model of its own is asked for first, with its effort", async () => {
  const { asked, attempt } = attempts({ workspaceId: "w1", status: "ready" });
  assert.deepEqual(await startOnChoice({ ...start, choice }, attempt), { workspaceId: "w1", status: "ready" });
  assert.deepEqual(asked, [chosen]);
  // With none, as before.
  const none = attempts({ workspaceId: "w1", status: "ready" });
  await startOnChoice(start, none.attempt);
  assert.deepEqual(none.asked, [outrunner]);
});

test("its own model refused, it starts as it would have without, saying why", async () => {
  const off = attempts(refused("Choose one of the offered models."), { workspaceId: "w2", status: "ready" });
  assert.deepEqual(await startOnChoice({ ...start, choice }, off.attempt), {
    workspaceId: "w2",
    status: "ready",
    fellBack: "It couldn't start on opus: Choose one of the offered models. Ran on Outrunner's models instead.",
  });
  assert.deepEqual(off.asked, [chosen, outrunner]);

  const harness = attempts(refused("Choose one of the offered models."), { workspaceId: "w2", status: "ready" });
  assert.equal(
    ((await startOnChoice({ ...start, choice, onHarness: true }, harness.attempt)) as { fellBack?: string }).fellBack,
    "It couldn't start on opus: Choose one of the offered models. Ran on your default model instead.",
  );
  assert.deepEqual(harness.asked, [chosen, own]);

  // On the org's harness, which fell back too: both said.
  const on = attempts(refused("Choose one of the offered models."), refused("Connect Claude."), { workspaceId: "w3", status: "ready" });
  const result = await startOnChoice({ ...start, choice, onHarness: true }, on.attempt);
  assert.deepEqual(on.asked, [chosen, own, outrunner]);
  assert.deepEqual(result, {
    workspaceId: "w3",
    status: "ready",
    fellBack:
      "It couldn't start on opus: Choose one of the offered models. Ran on Outrunner's models: it couldn't start on your own. Connect Claude.",
  });
});

test("a session made on its own model that failed is that session's, never a second one", async () => {
  const { asked, attempt } = attempts({ workspaceId: "w1", status: "failed", errorMessage: "Its box didn't start." });
  assert.equal((await startOnChoice({ ...start, choice }, attempt)).status, "failed");
  assert.equal(asked.length, 1);
});
