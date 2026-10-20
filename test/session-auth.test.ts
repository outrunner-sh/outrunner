import assert from "node:assert/strict";
import { test } from "node:test";

import type { ResolvedAuth } from "@/lib/agents/resolve";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import {
  deliverSessionAuth,
  OutdatedComputerError,
  requireAgentOnBox,
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
  const { c } = client(missingRoute);
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

test("a box that can't run Codex is refused before a session is made on it", async () => {
  await requireAgentOnBox(client(ok, async () => ["claude", "codex"]).c, "codex");
  await requireAgentOnBox(client(ok, async () => null).c, "claude");
  await assert.rejects(
    requireAgentOnBox(client(ok, async () => ["claude"]).c, "codex"),
    (error: Error) => error instanceof OutdatedComputerError && /can't run Codex/.test(error.message),
  );
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
