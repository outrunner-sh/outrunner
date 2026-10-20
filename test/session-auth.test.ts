import assert from "node:assert/strict";
import { test } from "node:test";

import type { ResolvedAuth } from "@/lib/agents/resolve";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import {
  deliverSessionAuth,
  OutdatedComputerError,
  requireAgentOnBox,
  restoreCredential,
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

test("a restore carries the credential; an agent from before credentials can take only the box's own", async () => {
  const picked: ResolvedAuth = { method: "api-key", credential: TOKEN, picked: true };
  const unpicked: ResolvedAuth = { method: "subscription", credential: TOKEN, picked: false };
  const current = client(ok, async () => ["claude", "codex"]).c;
  assert.deepEqual(await restoreCredential(current, "claude", picked), TOKEN);
  assert.equal(await restoreCredential(current, "claude", { method: null, credential: null, picked: false }), undefined);

  const old = client(ok, async () => null).c;
  // It would ignore the credential: fine for the one the box was set up with.
  assert.deepEqual(await restoreCredential(old, "claude", unpicked), TOKEN);
  await assert.rejects(restoreCredential(old, "claude", picked), OutdatedComputerError);
  await assert.rejects(restoreCredential(old, "codex", { method: "api-key", credential: KEY, picked: true }), /can't run Codex/);
});
