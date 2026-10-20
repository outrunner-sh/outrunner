import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentId } from "@/lib/agents/registry";
import type { ResolvedAuth } from "@/lib/agents/resolve";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import {
  deliverSessionAuth,
  OutdatedComputerError,
  readyBox,
  restoreSignedIn,
  type SessionAuthClient,
} from "@/lib/runtime/session-auth";

const KEY: ResolvedAuth["credential"] = { kind: "openai-api-key", token: "sk-proj-" + "o".repeat(40) };
const TOKEN: ResolvedAuth["credential"] = { kind: "claude-oauth-token", token: "sk-ant-oat01-" + "t".repeat(40) };

/** A client whose /auth answers `answer`, recording what it was given. */
function client(answer: () => Promise<unknown>, agents: SessionAuthClient["agents"] = async () => ["claude"]) {
  const given: unknown[] = [];
  const c: SessionAuthClient = {
    setAuth(credential) {
      given.push(credential);
      return answer();
    },
    agents,
  };
  return { c, given };
}

const ok = () => Promise.resolve({});
/** An agent from before /auth: a 404 with no error envelope. */
const missingRoute = () => Promise.reject(new AgentRequestError(404));

test("a credential goes to the session; none sends nothing", async () => {
  const { c, given } = client(ok);
  await deliverSessionAuth(c, "codex", { method: "api-key", credential: KEY, picked: true });
  assert.deepEqual(given, [KEY]);
  await deliverSessionAuth(c, "claude", { method: "local", credential: null, picked: true });
  await deliverSessionAuth(c, "claude", { method: null, credential: null, picked: false });
  assert.equal(given.length, 1);
});

test("an agent from before session credentials: fine for the box's own, refused for a pick", async () => {
  // An agent that old lists no agents, and can't be upgraded here.
  const { c } = client(missingRoute, async () => null);
  // Not picked: the box was set up with this same credential.
  await deliverSessionAuth(c, "claude", { method: "subscription", credential: TOKEN, picked: false });
  // Picked: running on the box's credential instead would bill another account.
  await assert.rejects(
    deliverSessionAuth(c, "claude", { method: "api-key", credential: TOKEN, picked: true }),
    (error: Error) => error instanceof OutdatedComputerError && /can't sign Claude Code in the way you chose/.test(error.message),
  );
  // Codex has nothing on the box to fall back on.
  await assert.rejects(
    deliverSessionAuth(c, "codex", { method: "api-key", credential: KEY, picked: false }),
    OutdatedComputerError,
  );
});

test("any other refusal is the agent's to tell", async () => {
  const refused = new AgentRequestError(400, { code: "INVALID_REQUEST", message: "kind does not fit the session's agent" });
  const { c } = client(() => Promise.reject(refused));
  await assert.rejects(deliverSessionAuth(c, "claude", { method: "subscription", credential: TOKEN, picked: false }), refused);
});

test("a box that can't run Codex is upgraded in place, and refused only if it still can't", async () => {
  const codexKey: ResolvedAuth = { method: "api-key", credential: KEY, picked: true };
  await readyBox(client(ok, async () => ["claude", "codex"]).c, "codex", codexKey);
  await readyBox(client(ok, async () => null).c, "claude", { method: null, credential: null, picked: false });

  // Upgraded: its agent then runs Codex.
  let upgraded = 0;
  let agents: Awaited<ReturnType<SessionAuthClient["agents"]>> = ["claude"];
  const box = client(ok, async () => agents).c;
  box.upgrade = async () => {
    upgraded++;
    agents = ["claude", "codex"];
  };
  await readyBox(box, "codex", codexKey);
  assert.equal(upgraded, 1);
  await readyBox(box, "codex", codexKey);
  assert.equal(upgraded, 1, "an up-to-date box isn't upgraded again");

  // No upgrade here (a provider that can't), or one that didn't take.
  await assert.rejects(
    readyBox(client(ok, async () => ["claude"]).c, "codex", codexKey),
    (error: Error) => error instanceof OutdatedComputerError && /can't run Codex/.test(error.message),
  );
  const stuck = client(ok, async () => ["claude"]).c;
  stuck.upgrade = async () => {};
  await assert.rejects(readyBox(stuck, "codex", codexKey), /can't run Codex/);
});

test("an agent from before session credentials is upgraded for a credential the session must have", async () => {
  let agents: AgentId[] | null = null;
  const sent: unknown[] = [];
  const c: SessionAuthClient = {
    agents: async () => agents,
    setAuth: async (credential) => {
      if (agents === null) throw new AgentRequestError(404);
      sent.push(credential);
    },
    upgrade: async () => {
      agents = ["claude", "codex"];
    },
  };
  // Unpicked: the box's own setup holds it; nothing is upgraded for it.
  await deliverSessionAuth(c, "claude", { method: "subscription", credential: TOKEN, picked: false });
  assert.equal(agents, null);
  // Picked: upgraded, then handed over.
  await deliverSessionAuth(c, "claude", { method: "api-key", credential: TOKEN, picked: true });
  assert.deepEqual(sent, [TOKEN]);
});

test("a restore carries the credential to an agent that takes one, picked or not", async () => {
  const picked: ResolvedAuth = { method: "api-key", credential: TOKEN, picked: true };
  const unpicked: ResolvedAuth = { method: "subscription", credential: TOKEN, picked: false };
  const sent: unknown[] = [];
  const restore = async (credential?: unknown) => void sent.push(credential);
  const current = client(ok, async () => ["claude", "codex"]).c;
  // A key replaced while the box ran: the restore relaunches on the new one.
  await restoreSignedIn(current, "claude", unpicked, restore);
  await restoreSignedIn(current, "claude", picked, restore);
  await restoreSignedIn(current, "claude", { method: null, credential: null, picked: false }, restore);
  assert.deepEqual(sent, [TOKEN, TOKEN, undefined]);

  // An agent from before credentials would ignore it: fine for the box's own.
  sent.length = 0;
  const old = client(ok, async () => null).c;
  await restoreSignedIn(old, "claude", unpicked, restore);
  assert.deepEqual(sent, [undefined]);
  await assert.rejects(restoreSignedIn(old, "claude", picked, restore), OutdatedComputerError);
  await assert.rejects(
    restoreSignedIn(old, "codex", { method: "api-key", credential: KEY, picked: true }, restore),
    /can't run Codex/,
  );
});

test("a jcode computer refuses a restore's credential: unpicked, it restores without", async () => {
  const unsupported = new AgentRequestError(409, { code: "UNSUPPORTED", message: "own login" });
  const sent: unknown[] = [];
  const restore = async (credential?: unknown) => {
    sent.push(credential);
    if (credential) throw unsupported;
  };
  const jcode = client(ok, async () => ["claude"]).c;
  await restoreSignedIn(jcode, "claude", { method: "subscription", credential: TOKEN, picked: false }, restore);
  assert.deepEqual(sent, [TOKEN, undefined]);
  await assert.rejects(
    restoreSignedIn(jcode, "claude", { method: "api-key", credential: TOKEN, picked: true }, restore),
    /runs every session on its own login/,
  );
});

test("an engine that runs sessions on its own login: like an agent without credentials", async () => {
  const unsupported = () =>
    Promise.reject(new AgentRequestError(409, { code: "UNSUPPORTED", message: "this computer's engine runs sessions on its own login" }));
  const { c } = client(unsupported);
  await deliverSessionAuth(c, "claude", { method: "subscription", credential: TOKEN, picked: false });
  await assert.rejects(
    deliverSessionAuth(c, "claude", { method: "api-key", credential: TOKEN, picked: true }),
    (error: Error) => error instanceof OutdatedComputerError && /runs every session on its own login/.test(error.message),
  );
});
