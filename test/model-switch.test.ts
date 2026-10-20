import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentRequestError } from "@/lib/runtime/agent-client";
import { AllowanceSpentError, OutrunnerModelsUnavailableError } from "@/lib/openrouter/keys";
import { NoStartingModelError, startingModel, switchFailure } from "@/lib/runtime/model-switch";
import { NoProviderKeyError } from "@/lib/providers/errors";
import { OUTRUNNER_MODELS, type SetModelRequest } from "@/lib/runtime/session-models";

const GLM = OUTRUNNER_MODELS[0];

test("a refusal from the agent passes its own advice through", () => {
  const busy = new AgentRequestError(409, {
    code: "CONFLICT",
    message: "Claude is mid-turn; switch models once it has finished",
  });
  assert.deepEqual(switchFailure(busy, GLM), { status: 409, message: "Claude is mid-turn; switch models once it has finished" });
});

test("a missing model route means the box's agent predates switching", () => {
  const { status, message } = switchFailure(new AgentRequestError(404), GLM);
  assert.equal(status, 409);
  assert.match(message, /older Outrunner that can't switch models/);
});

test("an unknown session is a failure, not an outdated agent", () => {
  const gone = new AgentRequestError(404, { code: "NOT_FOUND", message: "unknown workspace" });
  assert.equal(switchFailure(gone, GLM).status, 502);
});

test("an agent older than the model's provider says to update", () => {
  const old = new AgentRequestError(400, { code: "INVALID_REQUEST", message: 'unknown gateway "zai"' });
  const { status, message } = switchFailure(old, { id: "glm-5.3", label: "GLM 5.3", provider: "zai" });
  assert.equal(status, 409);
  assert.equal(message, "This session's Outrunner is too old to run Z.ai models. Update Outrunner and try again.");
});

test("anything else asks to try again, without the raw error", () => {
  for (const error of [new AgentRequestError(500, { code: "INTERNAL", message: "tmux: exit 1" }), new Error("fetch failed"), "x"]) {
    assert.deepEqual(switchFailure(error, GLM), { status: 502, message: "Couldn't switch models. Please try again." });
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
    fallback: GLM, keyFor: async () => KEY,
    hasClaude: false,
  });
  assert.equal(on, "outrunner");
  assert.deepEqual(sent, [{ model: "z-ai/glm-5.3", gateway: "openrouter", token: KEY }]);
});

test("it is the default with a Claude login too", async () => {
  let sent = 0;
  const on = await startingModel({ setModel: async () => sent++, fallback: GLM, keyFor: async () => KEY, hasClaude: true });
  assert.equal(on, "outrunner");
  assert.equal(sent, 1);
});

test("without Outrunner's models, a Claude login starts the session instead", async () => {
  let sent = 0;
  const on = await quiet(() =>
    startingModel({
      setModel: async () => sent++,
      fallback: GLM, keyFor: async () => {
        throw new OutrunnerModelsUnavailableError();
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
  assert.equal(await quiet(() => startingModel({ setModel: old, fallback: GLM, keyFor: async () => KEY, hasClaude: true })), "claude");
  await assert.rejects(
    startingModel({ setModel: old, fallback: GLM, keyFor: async () => KEY, hasClaude: false }),
    (error: unknown) => error instanceof NoStartingModelError && /older Outrunner/.test(error.message),
  );
});

test("with neither, the error says Outrunner's models are missing and to connect Claude", async () => {
  await assert.rejects(
    startingModel({
      setModel: async () => assert.fail("reached the agent"),
      fallback: GLM, keyFor: async () => {
        throw new OutrunnerModelsUnavailableError();
      },
      hasClaude: false,
    }),
    (error: unknown) =>
      error instanceof NoStartingModelError && /aren't available on this server\. Connect Claude/.test(error.message),
  );
});

test("a spent allowance falls back to Claude, or says what to do without it", async () => {
  const spent = async (): Promise<string> => {
    throw new AllowanceSpentError();
  };
  const setModel = async () => assert.fail("reached the agent");
  assert.equal(await quiet(() => startingModel({ setModel, fallback: GLM, keyFor: spent, hasClaude: true })), "claude");
  await assert.rejects(
    startingModel({ setModel, fallback: GLM, keyFor: spent, hasClaude: false }),
    (error: unknown) => error instanceof NoStartingModelError && error.message === new AllowanceSpentError().message,
  );
});

test("any other failure without Claude asks to try again", async () => {
  await assert.rejects(
    startingModel({
      setModel: async () => {
        throw new AgentRequestError(500, { code: "INTERNAL", message: "tmux: exit 1" });
      },
      fallback: GLM, keyFor: async () => KEY,
      hasClaude: false,
    }),
    (error: unknown) => error instanceof NoStartingModelError && /Please try again/.test(error.message) && !/tmux/.test(error.message),
  );
});

test("a session starts on the model chosen for it, on the key it was chosen on", async () => {
  const sent: SetModelRequest[] = [];
  const on = await startingModel({
    setModel: async (req) => void sent.push(req),
    fallback: GLM, keyFor: async () => KEY,
    hasClaude: false,
    model: { id: "anthropic/claude-opus-5.5", label: "Claude Opus", provider: "openrouter" },
  });
  assert.equal(on, "openrouter");
  assert.deepEqual(sent, [{ model: "anthropic/claude-opus-5.5", gateway: "openrouter", token: KEY }]);
});

test("a Claude account model needs the user's Claude, and runs on it with no key", async () => {
  const sent: SetModelRequest[] = [];
  const opus = { id: "opus", label: "Opus", provider: "claude" } as const;
  assert.equal(
    await startingModel({ setModel: async (req) => void sent.push(req), fallback: GLM, keyFor: async () => assert.fail("asked for a key"), hasClaude: true, model: opus }),
    "claude",
  );
  assert.deepEqual(sent, [{ model: "opus" }]);
  await assert.rejects(
    startingModel({ setModel: async () => assert.fail("reached the agent"), fallback: GLM, keyFor: async () => KEY, hasClaude: false, model: opus }),
    (error: unknown) => error instanceof NoStartingModelError && /Connect Claude/.test(error.message),
  );
});

test("a chosen model that can't be had fails instead of quietly becoming Claude", async () => {
  await assert.rejects(
    quiet(() =>
      startingModel({
        setModel: async () => assert.fail("reached the agent"),
        fallback: GLM, keyFor: async () => {
          throw new OutrunnerModelsUnavailableError();
        },
        hasClaude: true,
        model: { id: "z-ai/glm-5.3", label: "GLM 5.3", provider: "outrunner" },
      }),
    ),
    NoStartingModelError,
  );
});

test("a model on the user's own key runs through its provider, on their key", async () => {
  const sent: SetModelRequest[] = [];
  const asked: string[] = [];
  const on = await startingModel({
    setModel: async (req) => void sent.push(req),
    keyFor: async (holder) => {
      asked.push(holder);
      return "zai-key-0123456789abcdef.secret";
    },
    hasClaude: false,
    model: { id: "glm-5.3", label: "GLM 5.3", provider: "zai" },
    fallback: GLM,
  });
  assert.equal(on, "zai");
  assert.deepEqual(asked, ["zai"]);
  assert.deepEqual(sent, [{ model: "glm-5.3", gateway: "zai", token: "zai-key-0123456789abcdef.secret" }]);
});

test("a chosen provider without a saved key, or an agent older than it, says so", async () => {
  await assert.rejects(
    startingModel({
      setModel: async () => assert.fail("reached the agent"),
      keyFor: async () => {
        throw new NoProviderKeyError("deepseek");
      },
      hasClaude: true,
      model: { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "deepseek" },
      fallback: GLM,
    }),
    (error: unknown) => error instanceof NoStartingModelError && /Save your DeepSeek key in Settings → Providers/.test(error.message),
  );
  await assert.rejects(
    startingModel({
      setModel: async () => {
        throw new AgentRequestError(400, { code: "INVALID_REQUEST", message: 'unknown gateway "moonshot"' });
      },
      keyFor: async () => "sk-0123456789abcdef0123456789",
      hasClaude: false,
      model: { id: "kimi-k3", label: "Kimi K3", provider: "moonshot" },
      fallback: GLM,
    }),
    (error: unknown) => error instanceof NoStartingModelError && /too old to run Moonshot \(Kimi\) models/.test(error.message),
  );
});

test("with no default to start on, the session starts on the user's Claude, or says what's missing", async () => {
  let sent = 0;
  const on = await startingModel({ setModel: async () => sent++, keyFor: async () => assert.fail("asked for a key"), hasClaude: true, fallback: null });
  assert.equal(on, "claude");
  assert.equal(sent, 0, "the session's own Claude default, untouched");
  await assert.rejects(
    startingModel({ setModel: async () => assert.fail("reached the agent"), keyFor: async () => "k", hasClaude: false, fallback: null }),
    (error: unknown) => error instanceof NoStartingModelError && /Connect Claude/.test(error.message),
  );
});
