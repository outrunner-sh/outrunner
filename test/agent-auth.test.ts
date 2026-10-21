import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentId, AuthCredential, AuthMethodId, RunTarget } from "@/lib/agents/registry";
import {
  AgentAuthError,
  type AgentAuthStore,
  agentConnection,
  resignInNeedsAccount,
  resolveAgentAuth,
  type ResolvedAuth,
} from "@/lib/agents/resolve";

const OAT = "sk-ant-oat01-" + "t".repeat(40);
const ANTHROPIC = "sk-ant-api03-" + "a".repeat(40);
const OPENAI = "sk-proj-" + "o".repeat(40);

type Saved = { slot?: string; anthropic?: string; openai?: string };

/** A store holding `saved`, with `choice` picked, that records what it opened. */
function store(choice: AuthMethodId | string | null, saved: Saved, opened: string[] = []): AgentAuthStore {
  return {
    async load() {
      return {
        choice: choice as AuthMethodId | null,
        open(credential: AuthCredential) {
          if (credential.kind === "own-login") throw new Error("an own login has nothing to open");
          const which = credential.kind === "claude-slot" ? "slot" : credential.provider;
          opened.push(which);
          return saved[which as keyof Saved] ?? null;
        },
      };
    },
  };
}

type Case = {
  name: string;
  agent: AgentId;
  target: RunTarget;
  choice: AuthMethodId | string | null;
  saved: Saved;
  want: ResolvedAuth | { reason: "local-only" | "not-connected"; method: AuthMethodId };
};

const CASES: Case[] = [
  // No pick: as before there was one.
  { name: "claude, box, no pick: the subscription first", agent: "claude", target: "cloud", choice: null, saved: { slot: OAT, anthropic: ANTHROPIC },
    want: { method: "subscription", credential: { kind: "claude-oauth-token", token: OAT }, picked: false } },
  { name: "claude, box, no pick: else the API key", agent: "claude", target: "cloud", choice: null, saved: { anthropic: ANTHROPIC },
    want: { method: "api-key", credential: { kind: "anthropic-api-key", token: ANTHROPIC }, picked: false } },
  { name: "claude, box, no pick, nothing saved: the box's own setup", agent: "claude", target: "cloud", choice: null, saved: {},
    want: { method: null, credential: null, picked: false } },
  { name: "claude, Mac, no pick: its own login", agent: "claude", target: "local", choice: null, saved: { slot: OAT },
    want: { method: "local", credential: null, picked: false } },
  { name: "codex, box, no pick: the API key", agent: "codex", target: "cloud", choice: null, saved: { openai: OPENAI },
    want: { method: "api-key", credential: { kind: "openai-api-key", token: OPENAI }, picked: false } },
  { name: "codex, box, no pick, no key: nothing to run on", agent: "codex", target: "cloud", choice: null, saved: {},
    want: { reason: "not-connected", method: "api-key" } },
  { name: "codex, Mac, no pick: its own login", agent: "codex", target: "local", choice: null, saved: {},
    want: { method: "local", credential: null, picked: false } },

  // A pick is kept to, never swapped for another way.
  { name: "claude, box, API key picked over a subscription", agent: "claude", target: "cloud", choice: "api-key", saved: { slot: OAT, anthropic: ANTHROPIC },
    want: { method: "api-key", credential: { kind: "anthropic-api-key", token: ANTHROPIC }, picked: true } },
  { name: "claude, box, API key picked, none saved", agent: "claude", target: "cloud", choice: "api-key", saved: { slot: OAT },
    want: { reason: "not-connected", method: "api-key" } },
  { name: "claude, box, subscription picked, none saved", agent: "claude", target: "cloud", choice: "subscription", saved: { anthropic: ANTHROPIC },
    want: { reason: "not-connected", method: "subscription" } },
  { name: "claude, Mac, subscription picked: the token goes to the Mac's session", agent: "claude", target: "local", choice: "subscription", saved: { slot: OAT },
    want: { method: "subscription", credential: { kind: "claude-oauth-token", token: OAT }, picked: true } },
  { name: "claude, box, local agent picked: Mac only", agent: "claude", target: "cloud", choice: "local", saved: { slot: OAT },
    want: { reason: "local-only", method: "local" } },
  { name: "codex, box, ChatGPT picked: Mac only, though a key is saved", agent: "codex", target: "cloud", choice: "chatgpt", saved: { openai: OPENAI },
    want: { reason: "local-only", method: "chatgpt" } },
  { name: "codex, Mac, ChatGPT picked: its own login", agent: "codex", target: "local", choice: "chatgpt", saved: { openai: OPENAI },
    want: { method: "chatgpt", credential: null, picked: true } },
  { name: "codex, Mac, API key picked: the key goes to the Mac's session", agent: "codex", target: "local", choice: "api-key", saved: { openai: OPENAI },
    want: { method: "api-key", credential: { kind: "openai-api-key", token: OPENAI }, picked: true } },
  { name: "codex, Mac, API key picked, none saved (or it can't be opened)", agent: "codex", target: "local", choice: "api-key", saved: {},
    want: { reason: "not-connected", method: "api-key" } },

  // A pick this release doesn't know, or another agent's, is no pick.
  { name: "claude, a later release's pick", agent: "claude", target: "cloud", choice: "sso", saved: { anthropic: ANTHROPIC },
    want: { method: "api-key", credential: { kind: "anthropic-api-key", token: ANTHROPIC }, picked: false } },
  { name: "claude, Codex's pick", agent: "claude", target: "local", choice: "chatgpt", saved: {},
    want: { method: "local", credential: null, picked: false } },

  // An API key left in the Claude slot runs as the API key it is.
  { name: "claude, subscription picked, an old API key in the slot", agent: "claude", target: "cloud", choice: "subscription", saved: { slot: ANTHROPIC },
    want: { method: "subscription", credential: { kind: "anthropic-api-key", token: ANTHROPIC }, picked: true } },
];

for (const c of CASES) {
  test(c.name, async () => {
    const run = resolveAgentAuth(store(c.choice, c.saved), c.agent, c.target);
    if ("reason" in c.want) {
      const { reason, method } = c.want;
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof AgentAuthError);
        assert.equal(error.reason, reason);
        assert.equal(error.method, method);
        assert.equal(error.agent, c.agent);
        assert.equal(error.settingsHref, `/settings/providers?tab=${c.agent}&method=${method}`);
        return true;
      });
    } else {
      assert.deepEqual(await run, c.want);
    }
  });
}

test("only the credential the pick needs is opened", async () => {
  const opened: string[] = [];
  await resolveAgentAuth(store("api-key", { slot: OAT, anthropic: ANTHROPIC }, opened), "claude", "cloud");
  assert.deepEqual(opened, ["anthropic"]);

  opened.length = 0;
  await resolveAgentAuth(store("local", { slot: OAT }, opened), "claude", "local");
  assert.deepEqual(opened, []);
});

test("the errors say what to do, and where", async () => {
  await assert.rejects(resolveAgentAuth(store("chatgpt", {}), "codex", "cloud"), /sign in with ChatGPT, which works for sessions on your Mac only\. Choose API key under Settings → Providers → Codex/);
  await assert.rejects(resolveAgentAuth(store("api-key", {}), "codex", "local"), /Save your OpenAI API key under Settings → Providers → Codex/);
  await assert.rejects(resolveAgentAuth(store("subscription", {}), "claude", "cloud"), /Connect your Claude subscription under Settings → Providers → Claude Code/);
});

test("on a model on a key, a pick that can't run signs in to nothing instead", async () => {
  const unsigned = { method: null, credential: null, picked: false };
  const run = (choice: AuthMethodId | null, saved: Saved, target: RunTarget, agent: AgentId = "claude") =>
    resolveAgentAuth(store(choice, saved), agent, target, { ownAccount: false });
  // Disconnected after it was picked.
  assert.deepEqual(await run("subscription", {}, "cloud"), unsigned);
  assert.deepEqual(await run("subscription", {}, "local"), unsigned);
  // The Mac's own login, on a box.
  assert.deepEqual(await run("local", {}, "cloud"), unsigned);
  // A pick that can run still signs in: the session can switch to the account.
  assert.deepEqual(await run("subscription", { slot: OAT }, "cloud"), {
    method: "subscription",
    credential: { kind: "claude-oauth-token", token: OAT },
    picked: true,
  });
  // Signing in again, model unknown: Claude Code may be on a key, Codex never is.
  assert.equal(resignInNeedsAccount("claude"), false);
  assert.equal(resignInNeedsAccount("codex"), true);
});

test("where each agent's own account is connected", async () => {
  const connection = (agent: AgentId, choice: AuthMethodId | null, saved: Saved) =>
    agentConnection(store(choice, saved), agent);
  // Nothing picked or saved: not connected, as Settings shows it.
  assert.deepEqual(await connection("claude", null, {}), { cloud: false, local: false });
  assert.deepEqual(await connection("codex", null, {}), { cloud: false, local: false });
  // Picked, then disconnected: not connected, though another way has a key.
  assert.deepEqual(await connection("claude", "subscription", { anthropic: ANTHROPIC }), { cloud: false, local: false });
  // Picked and saved: everywhere.
  assert.deepEqual(await connection("claude", "subscription", { slot: OAT }), { cloud: true, local: true });
  assert.deepEqual(await connection("codex", "api-key", { openai: OPENAI }), { cloud: true, local: true });
  // The Mac's own login picked: on the Mac, as it is logged in.
  assert.deepEqual(await connection("claude", "local", { slot: OAT }), { cloud: false, local: "mac-login" });
  assert.deepEqual(await connection("codex", "chatgpt", {}), { cloud: false, local: "mac-login" });
  // No pick, a key saved: on a box; on the Mac a session runs on its own login.
  assert.deepEqual(await connection("claude", null, { anthropic: ANTHROPIC }), { cloud: true, local: "mac-login" });
});
