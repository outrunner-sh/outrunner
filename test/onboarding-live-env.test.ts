import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { RepositoryListing } from "@/lib/github/listing";
import { liveEnv, OnboardingError } from "@/lib/onboarding/live-env";
import {
  CLI_DEFAULT_URL,
  connectClaudeCommand,
  connectedAgent,
  filterRepositories,
  freeModelsOffer,
  newSessionAfterOnboarding,
  parseAgentPick,
  parseProgress,
  resumeAt,
  resumeDesktopAt,
  sortRepositories,
  startingPick,
} from "@/lib/onboarding/rules";
import type { AgentStatus } from "@/lib/onboarding/types";
import { CLAUDE_DEFAULT_MODEL, CODEX_MODELS, OUTRUNNER_MODELS } from "@/lib/runtime/session-models";

const user = { id: "u1", name: "Ada Lovelace", login: "ada", avatarUrl: null };
const realFetch = globalThis.fetch;

type Call = { url: string; method: string; body: unknown };

/** Answer each request by URL and method; record them in order. */
function stubFetch(routes: Record<string, (body: unknown) => [number, unknown]>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const route = routes[`${method} ${url}`];
    if (!route) return new Response(JSON.stringify({ error: `unexpected ${method} ${url}` }), { status: 500 });
    const [status, json] = route(body);
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
  return calls;
}

const env = () => liveEnv(user, { outrunnerModels: true });

const statusRoutes = (claude: { connected: boolean; last4: string | null }, keys: Record<string, { connected: boolean }>) => ({
  "GET /api/settings/claude": () => [200, claude] as [number, unknown],
  "GET /api/settings/providers": () => [200, { keys }] as [number, unknown],
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("what's connected is read from Settings' own routes", async () => {
  stubFetch(statusRoutes({ connected: true, last4: "a1b2" }, { anthropic: { connected: false }, openai: { connected: true } }));
  assert.deepEqual(await env().agentStatus(), {
    claude: { subscription: true, last4: "a1b2", apiKey: false },
    codex: { apiKey: true },
  });
});

test("a pasted token and an API key are saved where Settings saves them, then read back", async () => {
  const calls = stubFetch({
    "PUT /api/settings/claude": () => [200, { connected: true, last4: "p4st" }],
    "PUT /api/settings/providers": () => [200, { keys: {} }],
    ...statusRoutes({ connected: true, last4: "p4st" }, { anthropic: { connected: true } }),
  });
  await env().saveClaudeToken("sk-ant-oat01-token");
  await env().saveApiKey("anthropic", "sk-ant-api03-key");
  const writes = calls.filter((c) => c.method === "PUT");
  assert.deepEqual(writes, [
    { url: "/api/settings/claude", method: "PUT", body: { token: "sk-ant-oat01-token" } },
    { url: "/api/settings/providers", method: "PUT", body: { provider: "anthropic", key: "sk-ant-api03-key" } },
  ]);
});

test("picking repositories connects just those, as the repository picker does", async () => {
  const calls = stubFetch({ "POST /api/projects/sync": () => [200, { projects: [{ id: "p1", githubRepoId: 7 }] }] });
  const projects = await env().connect([7]);
  assert.deepEqual(calls[0].body, { repoIds: [7] });
  assert.equal(projects[0].id, "p1");
});

test("finishing marks onboarding done and opens the new-session screen on the repository and agent picked", async () => {
  const calls = stubFetch({ "POST /api/onboarding/complete": () => [200, { ok: true }] });
  assert.equal(await env().finish("p1", "claude"), "/new?project=p1&focus=composer&start=claude");
  // No session is started from onboarding: the user starts it, with a prompt.
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["POST /api/onboarding/complete"]);
});

test("skipping marks onboarding done and goes home", async () => {
  stubFetch({ "POST /api/onboarding/complete": () => [200, { ok: true }] });
  assert.equal(await env().skip(), "/");
});

test("the first session starts on the agent picked: the user's own at High, or Outrunner's, named", () => {
  assert.deepEqual(startingPick("claude"), { model: CLAUDE_DEFAULT_MODEL, effort: "high" });
  assert.deepEqual(startingPick("codex"), { model: CODEX_MODELS[0], effort: "high" });
  // Named, so a user whose Claude is connected still starts on what they picked.
  assert.deepEqual(startingPick("outrunner"), { model: OUTRUNNER_MODELS[0], effort: null });
  // In Codex, not Claude Code (Outrunner's models' default agent).
  assert.deepEqual(startingPick("codex-outrunner"), { model: OUTRUNNER_MODELS[0], effort: null, agent: "codex" });
});

test("the agent picked rides the new-session link and is read back; anything else is ignored", () => {
  const href = newSessionAfterOnboarding(undefined, "codex-outrunner");
  // No repository connected: the form picks its own.
  assert.equal(href, "/new?focus=composer&start=codex-outrunner");
  assert.equal(parseAgentPick(new URL(href, "http://x").searchParams.get("start")), "codex-outrunner");
  assert.equal(parseAgentPick("gpt"), undefined);
  assert.equal(parseAgentPick(null), undefined);
});

test("Outrunner's models are offered as the Free plan gives them", () => {
  // The Free plan's $5, at 5¢ a credit.
  assert.equal(freeModelsOffer(), "100 free credits");
});

test("the terminal command connects Claude to this app, without opening onboarding again", () => {
  // The app is always named, even the default: OUTRUNNER_URL in the user's shell would win otherwise.
  assert.equal(connectClaudeCommand("npx", CLI_DEFAULT_URL), "npx outrunner@latest --url https://app.outrunner.sh claude");
  assert.equal(connectClaudeCommand("pnpm dlx", "http://localhost:3000"), "pnpm dlx outrunner@latest --url http://localhost:3000 claude");
  assert.equal(
    connectClaudeCommand("npx", CLI_DEFAULT_URL, "u-1"),
    "npx outrunner@latest --url https://app.outrunner.sh --account u-1 claude",
  );
});

test("repositories show most recently pushed first, and filter by name or description", () => {
  const repo = (fullName: string, pushedAt: string | null, description: string | null = null) =>
    ({ fullName, pushedAt, description }) as RepositoryListing;
  const sorted = sortRepositories([repo("a/old", "2026-01-01"), repo("a/new", "2026-10-01"), repo("a/never", null)]);
  assert.deepEqual(sorted.map((r) => r.fullName), ["a/new", "a/old", "a/never"]);
  const list = [repo("acme/web", null, "Marketing site"), repo("acme/api", null)];
  assert.deepEqual(filterRepositories(list, "MARKET").map((r) => r.fullName), ["acme/web"]);
  assert.equal(filterRepositories(list, "  ").length, 2);
});

test("GitHub's refusal is carried as reconnect, and other errors aren't", async () => {
  stubFetch({ "GET /api/github/repositories": () => [409, { error: "Your GitHub connection has expired.", reconnect: true }] });
  await assert.rejects(env().repositories(), (e: unknown) => e instanceof OnboardingError && e.reconnect);
  stubFetch({ "GET /api/github/repositories": () => [502, { error: "GitHub could not list your repositories." }] });
  await assert.rejects(env().repositories(), (e: unknown) => e instanceof OnboardingError && !e.reconnect);
});

test("a refused onboarding mark is logged, and the new-session screen still opens", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  stubFetch({ "POST /api/onboarding/complete": () => [500, { error: "db down" }] });
  assert.equal(await env().finish("p1", "outrunner"), "/new?project=p1&focus=composer&start=outrunner");
  assert.equal(logged.mock.callCount(), 1);
});

const agents = (claude: Partial<AgentStatus["claude"]> = {}, codexKey = false): AgentStatus => ({
  claude: { subscription: false, last4: null, apiKey: false, ...claude },
  codex: { apiKey: codexKey },
});

const none = { claude: null, codex: null };

test("an agent connected already is the user's pick when it's connected, else subscription, then Anthropic, then OpenAI", () => {
  assert.equal(connectedAgent(agents(), none), null);
  assert.deepEqual(connectedAgent(agents({ subscription: true, apiKey: true }, true), none), {
    agent: "claude",
    method: "subscription",
    chosen: false,
  });
  assert.deepEqual(connectedAgent(agents({ apiKey: true }, true), none), { agent: "claude", method: "api-key", chosen: false });
  assert.deepEqual(connectedAgent(agents({}, true), none), { agent: "codex", method: "api-key", chosen: false });
  // An Anthropic key picked on purpose in Settings stays the pick.
  assert.deepEqual(connectedAgent(agents({ subscription: true, apiKey: true }), { claude: "api-key", codex: null }), {
    agent: "claude",
    method: "api-key",
    chosen: true,
  });
});

test("onboarding opens past the Agent step once an agent is connected, as from the CLI in another tab", () => {
  assert.deepEqual(resumeAt(null, agents(), none), { step: "agent", done: [], runOn: "outrunner" });
  assert.deepEqual(resumeAt(null, agents({ subscription: true }), none), {
    step: "repos",
    done: ["agent"],
    runOn: "claude",
    save: { agent: "claude", method: "subscription" },
  });
  // The tab that showed the command saved the Agent step before the CLI ran.
  assert.equal(resumeAt({ step: "agent", done: [], runOn: "outrunner" }, agents({ subscription: true }), none).step, "repos");
});

test("passing the Agent step keeps a pick the user made, and makes none blind", () => {
  const picked = resumeAt(null, agents({ subscription: true, apiKey: true }), { claude: "api-key", codex: null });
  assert.equal(picked.step, "repos");
  assert.equal(picked.save, undefined);
  // Their picks unknown: the Agent step, where they pick.
  assert.deepEqual(resumeAt(null, agents({ subscription: true }), null), { step: "agent", done: [], runOn: "outrunner" });
});

test("onboarding opens where it was left, and a user gone back to the Agent step stays there", () => {
  // Back from installing the GitHub App.
  assert.deepEqual(resumeAt({ step: "repos", done: ["agent"], runOn: "outrunner" }, agents(), none), {
    step: "repos",
    done: ["agent"],
    runOn: "outrunner",
  });
  const back = resumeAt({ step: "agent", done: ["agent", "repos"], runOn: "outrunner" }, agents({ subscription: true }), none);
  assert.equal(back.step, "agent");
  assert.equal(back.save, undefined);
});

test("an Agent step done on the user's own agent that can't run now is the Agent step again", () => {
  assert.deepEqual(resumeAt({ step: "repos", done: ["agent", "repos"], runOn: "claude" }, agents(), none), {
    step: "agent",
    done: ["repos"],
    runOn: "outrunner",
  });
  // Not known (the status couldn't be read): the progress stands.
  assert.deepEqual(resumeAt({ step: "repos", done: ["agent"], runOn: "claude" }, null, none), {
    step: "repos",
    done: ["agent"],
    runOn: "claude",
  });
  assert.equal(resumeAt(null, null, none).step, "agent");
  // Still connected another way: carry on.
  assert.equal(resumeAt({ step: "repos", done: ["agent"], runOn: "claude" }, agents({ apiKey: true }), none).step, "repos");
});

test("saved progress is only taken as it should be", () => {
  assert.deepEqual(parseProgress({ step: "repos", done: ["repos", "agent", "x"], runOn: "codex" }), {
    step: "repos",
    done: ["agent", "repos"],
    runOn: "codex",
  });
  // Saved when there was a Start step: onboarding now ends on Repositories.
  assert.deepEqual(parseProgress({ step: "start", done: ["agent", "repos", "start"], runOn: "codex" }), {
    step: "repos",
    done: ["agent", "repos"],
    runOn: "codex",
  });
  assert.equal(parseProgress(null), null);
  assert.equal(parseProgress("repos"), null);
  assert.equal(parseProgress({ step: "done", done: [], runOn: "claude" }), null);
  assert.equal(parseProgress({ step: "repos", done: [], runOn: "gpt" }), null);
  assert.equal(parseProgress({ step: "repos", done: "agent", runOn: "claude" }), null);
});

test("progress is kept per account in this browser, and dropped once onboarding is done", async (t) => {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  Object.defineProperty(globalThis, "window", { value: { localStorage }, configurable: true });
  t.after(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  const progress = { step: "repos", done: ["agent"], runOn: "claude" } as const;
  env().saveProgress({ ...progress, done: [...progress.done] });
  assert.deepEqual(env().savedProgress(), progress);
  assert.equal(liveEnv({ ...user, id: "u2" }, { outrunnerModels: true }).savedProgress(), null);

  stubFetch({ "POST /api/onboarding/complete": () => [200, { ok: true }] });
  await env().skip();
  assert.equal(env().savedProgress(), null);
  env().saveProgress({ ...progress, done: [...progress.done] });
  await env().finish("p1", "claude");
  assert.equal(env().savedProgress(), null);
});

test("storage that fails only means onboarding opens at its start", (t) => {
  const failing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); }, removeItem: () => {} };
  Object.defineProperty(globalThis, "window", { value: { localStorage: failing }, configurable: true });
  t.after(() => {
    delete (globalThis as { window?: unknown }).window;
  });
  assert.doesNotThrow(() => env().saveProgress({ step: "repos", done: [], runOn: "claude" }));
  assert.equal(env().savedProgress(), null);
});

test("desktop progress preserves the execution target and never skips agent/location selection on detection alone", () => {
  const found: AgentStatus = {
    ...agents({}, true),
    codex: { apiKey: false, account: true },
    local: { deviceId: "mac", root: "/r", agentBundled: true, git: "/g", tmux: "/t", claude: null,
      agents: { claude: { path: null, loggedIn: null, method: null }, codex: { path: "/codex", loggedIn: true, method: "chatgpt" } } },
  };
  assert.equal(resumeDesktopAt(null, found).step, "agent");
  const saved = { step: "repos", done: ["agent"], runOn: "codex", target: "local" } as const;
  const parsed = parseProgress(saved)!;
  assert.equal(parsed.target, "local");
  assert.equal(resumeDesktopAt(parsed, found).step, "repos");
  found.local!.agents!.codex.loggedIn = false;
  assert.equal(resumeDesktopAt(parsed, found).step, "agent");
  // A valid cloud account does not stand in for a missing local login.
  assert.equal(resumeDesktopAt({ ...parsed, target: "cloud" }, found).step, "repos");
  const href = newSessionAfterOnboarding(undefined, "codex", "local", "/Users/ada/my project");
  const query = new URL(href, "https://app.test").searchParams;
  assert.equal(query.get("target"), "local");
  assert.equal(query.get("folder"), "/Users/ada/my project");
});

test("a saved Codex ChatGPT account is recognized alongside API keys", async () => {
  stubFetch({ ...statusRoutes({ connected: false, last4: null }, {}),
    "GET /api/onboarding/agents": () => [200, { methods: { claude: [], codex: ["codex-account"] } }],
  });
  const status = await env().agentStatus();
  assert.equal(status.codex.account, true);
  assert.deepEqual(connectedAgent(status, { claude: null, codex: "codex-account" }), { agent: "codex", method: "codex-account", chosen: true });
});
