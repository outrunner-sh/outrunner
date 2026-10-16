import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentRequestError } from "@/lib/runtime/agent-client";
import { NeevAiUnavailableError } from "@/lib/openrouter/keys";
import { NoStartingModelError, startingModel, switchFailure } from "@/lib/runtime/model-switch";
import type { SetModelRequest } from "@/lib/runtime/session-models";

test("a refusal from the agent passes its own advice through", () => {
  const busy = new AgentRequestError(409, {
    code: "CONFLICT",
    message: "Claude is mid-turn; switch models once it has finished",
  });
  assert.deepEqual(switchFailure(busy), { status: 409, message: "Claude is mid-turn; switch models once it has finished" });
});

test("a missing model route means the box's agent predates switching", () => {
  const { status, message } = switchFailure(new AgentRequestError(404));
  assert.equal(status, 409);
  assert.match(message, /older Outrunner that can't switch models/);
});

test("an unknown session is a failure, not an outdated agent", () => {
  const gone = new AgentRequestError(404, { code: "NOT_FOUND", message: "unknown workspace" });
  assert.equal(switchFailure(gone).status, 502);
});

test("anything else asks to try again, without the raw error", () => {
  for (const error of [new AgentRequestError(500, { code: "INTERNAL", message: "tmux: exit 1" }), new Error("fetch failed"), "x"]) {
    assert.deepEqual(switchFailure(error), { status: 502, message: "Couldn't switch models. Please try again." });
  }
});

const KEY = "sk-or-v1-test-key-0123456789";
const quiet = <T>(run: () => Promise<T>): Promise<T> => {
  const warn = console.warn;
  console.warn = () => {};
  return run().finally(() => {
    console.warn = warn;
  });
};

test("a new session starts on Outrunner's default model, through OpenRouter", async () => {
  const sent: SetModelRequest[] = [];
  const on = await startingModel({
    setModel: async (req) => sent.push(req),
    neevKey: async () => KEY,
    hasClaude: false,
  });
  assert.equal(on, "outrunner");
  assert.deepEqual(sent, [{ model: "z-ai/glm-5.3", gateway: "openrouter", token: KEY }]);
});

test("it is the default with a Claude login too", async () => {
  let sent = 0;
  const on = await startingModel({ setModel: async () => sent++, neevKey: async () => KEY, hasClaude: true });
  assert.equal(on, "outrunner");
  assert.equal(sent, 1);
});

test("without Outrunner's models, a Claude login starts the session instead", async () => {
  let sent = 0;
  const on = await quiet(() =>
    startingModel({
      setModel: async () => sent++,
      neevKey: async () => {
        throw new NeevAiUnavailableError();
      },
      hasClaude: true,
    }),
  );
  assert.equal(on, "claude");
  assert.equal(sent, 0, "nothing reached the agent");
});

test("a box too old to switch falls back to Claude, or says why without it", async () => {
  const old = async () => {
    throw new AgentRequestError(404);
  };
  assert.equal(await quiet(() => startingModel({ setModel: old, neevKey: async () => KEY, hasClaude: true })), "claude");
  await assert.rejects(
    startingModel({ setModel: old, neevKey: async () => KEY, hasClaude: false }),
    (error: unknown) => error instanceof NoStartingModelError && /older Outrunner/.test(error.message),
  );
});

test("with neither, the error says Outrunner's models are missing and to connect Claude", async () => {
  await assert.rejects(
    startingModel({
      setModel: async () => assert.fail("reached the agent"),
      neevKey: async () => {
        throw new NeevAiUnavailableError();
      },
      hasClaude: false,
    }),
    (error: unknown) =>
      error instanceof NoStartingModelError && /aren't available on this server\. Connect Claude/.test(error.message),
  );
});

test("any other failure without Claude asks to try again", async () => {
  await assert.rejects(
    startingModel({
      setModel: async () => {
        throw new AgentRequestError(500, { code: "INTERNAL", message: "tmux: exit 1" });
      },
      neevKey: async () => KEY,
      hasClaude: false,
    }),
    (error: unknown) => error instanceof NoStartingModelError && /Please try again/.test(error.message) && !/tmux/.test(error.message),
  );
});

test("a session starts on the model chosen for it, on the key it was chosen on", async () => {
  const sent: SetModelRequest[] = [];
  const on = await startingModel({
    setModel: async (req) => void sent.push(req),
    neevKey: async () => KEY,
    hasClaude: false,
    model: { id: "anthropic/claude-opus-5.5", label: "Claude Opus", source: "own" },
  });
  assert.equal(on, "outrunner");
  assert.deepEqual(sent, [{ model: "anthropic/claude-opus-5.5", gateway: "openrouter", token: KEY }]);
});

test("a Claude account model needs the user's Claude, and runs on it with no key", async () => {
  const sent: SetModelRequest[] = [];
  const opus = { id: "opus", label: "Opus", source: "claude" } as const;
  assert.equal(
    await startingModel({ setModel: async (req) => void sent.push(req), neevKey: async () => assert.fail("asked for a key"), hasClaude: true, model: opus }),
    "claude",
  );
  assert.deepEqual(sent, [{ model: "opus" }]);
  await assert.rejects(
    startingModel({ setModel: async () => assert.fail("reached the agent"), neevKey: async () => KEY, hasClaude: false, model: opus }),
    (error: unknown) => error instanceof NoStartingModelError && /Connect Claude/.test(error.message),
  );
});

test("a chosen model that can't be had fails instead of quietly becoming Claude", async () => {
  await assert.rejects(
    quiet(() =>
      startingModel({
        setModel: async () => assert.fail("reached the agent"),
        neevKey: async () => {
          throw new NeevAiUnavailableError();
        },
        hasClaude: true,
        model: { id: "z-ai/glm-5.3", label: "GLM 5.3", source: "neev" },
      }),
    ),
    NoStartingModelError,
  );
});
