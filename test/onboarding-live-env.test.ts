import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { ConnectError, connectRepositories } from "@/lib/client/repository-listing";
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
  pickedProjects,
  resumeAt,
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

const org = { id: "o1", name: "Acme", personal: false };
const env = () => liveEnv(user, org, { outrunnerModels: true });

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

test("picking repositories connects just those, by their ids", async () => {
  const calls = stubFetch({ "POST /api/projects/sync": () => [200, { projects: [{ id: "p1", githubRepoId: 7 }] }] });
  const projects = await connectRepositories([7], "github");
  assert.deepEqual(calls[0].body, { repoIds: [7] });
  assert.equal(projects[0].id, "p1");
});

test("GitLab onboarding reads and saves its connection in place using the Settings API", async () => {
  const connection = { login: "ada", updatedAt: "2026-11-13T00:00:00Z" };
  const calls = stubFetch({
    "GET /api/gitlab/connection": () => [200, { connection: null }],
    "POST /api/gitlab/connection": () => [200, { connection }],
    "DELETE /api/gitlab/connection": () => [200, { connection: null }],
  });
  assert.equal(await env().gitlabConnection(), null);
  assert.deepEqual(await env().saveGitlabConnection("glpat_fixture"), connection);
  assert.deepEqual(calls[1], { method: "POST", url: "/api/gitlab/connection", body: { token: "glpat_fixture" } });
  assert.equal(await env().saveGitlabConnection(null), null);
  assert.equal(calls[2].method, "DELETE");
});

test("picked GitLab repositories are connected one at a time, without calling GitHub", async () => {
  const projects = [{ id: "gitlab-7", provider: "gitlab", repositoryId: 7, githubRepoId: null }, { id: "gitlab-8", provider: "gitlab", repositoryId: 8, githubRepoId: null }];
  const calls = stubFetch({ "POST /api/gitlab/projects": () => [200, { projects }] });
  assert.deepEqual(await connectRepositories([7, 8], "gitlab"), projects);
  assert.deepEqual(calls.map((call) => call.url), ["/api/gitlab/projects", "/api/gitlab/projects"]);
  assert.deepEqual(calls.map((call) => call.body), [{ repoId: 7 }, { repoId: 8 }]);
});

test("an installation on GitHub is added to the org being set up, as Settings → Org → GitHub adds it", async () => {
  const calls = stubFetch({ "POST /api/orgs/o1/github/installations": () => [200, { claimed: 42 }] });
  await env().addInstallation(42);
  assert.deepEqual(calls, [{ method: "POST", url: "/api/orgs/o1/github/installations", body: { installationId: 42 } }]);
});

test("the org's first environment is made of the repositories picked, as its default", async () => {
  const calls = stubFetch({ "POST /api/environments": () => [201, { id: "env-1" }] });
  assert.equal(await env().createEnvironment("Acme", ["p1", "p2"]), "env-1");
  assert.deepEqual(calls[0].body, { name: "Acme", projectIds: ["p1", "p2"], orgDefault: true });
  stubFetch({ "POST /api/environments": () => [400, { error: "An environment holds at most 5 repositories." }] });
  await assert.rejects(env().createEnvironment("Acme", ["p1"]), (e: unknown) => e instanceof OnboardingError && /at most 5/.test(e.message));
});

test("a rejected GitLab onboarding token stays an actionable error", async () => {
  stubFetch({ "POST /api/gitlab/connection": () => [409, { error: "Your GitLab token expired.", settingsHref: "/settings/connections" }] });
  await assert.rejects(env().saveGitlabConnection("expired"), (error: unknown) => error instanceof OnboardingError && error.message === "Your GitLab token expired." && error.href === "/settings/connections");
});

test("finishing marks the org set up and opens the new-session screen on the environment and agent picked", async () => {
  const calls = stubFetch({ "POST /api/onboarding/complete": () => [200, { ok: true }] });
  assert.equal(await env().finish("env-1", "claude"), "/new?environment=env-1&focus=composer&start=claude");
  // No session is started from onboarding: the user starts it, with a prompt.
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["POST /api/onboarding/complete"]);
});

test("skipping marks the org set up and goes home", async () => {
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
  const href = newSessionAfterOnboarding("env-1", "codex-outrunner");
  assert.equal(href, "/new?environment=env-1&focus=composer&start=codex-outrunner");
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

test("picks keep the order they were ticked in, not the most recently pushed", () => {
  // As the connect routes return them: every project, most recently pushed first.
  const projects = [
    { id: "recent", githubRepoId: 3 },
    { id: "gitlab", provider: "gitlab" as const, githubRepoId: null, repositoryId: 2 },
    { id: "ticked-first", githubRepoId: 2 },
    { id: "ticked-second", githubRepoId: 1 },
  ];
  assert.deepEqual(pickedProjects(projects, [2, 1], "github").map((p) => p.id), ["ticked-first", "ticked-second"]);
  assert.deepEqual(pickedProjects(projects, [2], "gitlab").map((p) => p.id), ["gitlab"]);
  assert.deepEqual(pickedProjects(projects, [9], "github"), []);
});

test("GitHub's refusal to connect is carried as reconnect, and other errors aren't", async () => {
  stubFetch({ "POST /api/projects/sync": () => [409, { error: "Your GitHub connection has expired.", reconnect: true }] });
  await assert.rejects(connectRepositories([7], "github"), (e: unknown) => e instanceof ConnectError && e.reconnect);
  stubFetch({ "POST /api/projects/sync": () => [403, { error: "Outrunner's GitHub App can't reach this repository.", code: "repo-no-access" }] });
  await assert.rejects(connectRepositories([7], "github"), (e: unknown) => e instanceof ConnectError && !e.reconnect && e.noAccess);
});

test("a refused onboarding mark is logged, and the new-session screen still opens", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  stubFetch({ "POST /api/onboarding/complete": () => [500, { error: "db down" }] });
  assert.equal(await env().finish("env-1", "outrunner"), "/new?environment=env-1&focus=composer&start=outrunner");
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

test("setup opens past the Agent step once an agent is connected, as from the CLI in another tab", () => {
  assert.deepEqual(resumeAt(null, agents(), none), { step: "agent", done: [], runOn: "outrunner" });
  assert.deepEqual(resumeAt(null, agents({ subscription: true }), none), {
    step: "github",
    done: ["agent"],
    runOn: "claude",
    save: { agent: "claude", method: "subscription" },
  });
  // The tab that showed the command saved the Agent step before the CLI ran.
  assert.equal(resumeAt({ step: "agent", done: [], runOn: "outrunner" }, agents({ subscription: true }), none).step, "github");
});

test("passing the Agent step keeps a pick the user made, and makes none blind", () => {
  const picked = resumeAt(null, agents({ subscription: true, apiKey: true }), { claude: "api-key", codex: null });
  assert.equal(picked.step, "github");
  assert.equal(picked.save, undefined);
  // Their picks unknown: the Agent step, where they pick.
  assert.deepEqual(resumeAt(null, agents({ subscription: true }), null), { step: "agent", done: [], runOn: "outrunner" });
});

test("setup opens where it was left, and a user gone back to the Agent step stays there", () => {
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
  // Saved when there was a Start step: its Repositories step.
  assert.deepEqual(parseProgress({ step: "start", done: ["agent", "repos", "start"], runOn: "codex" }), {
    step: "repos",
    done: ["agent", "repos"],
    runOn: "codex",
  });
  // The Environment step's picks aren't kept: they're picked again.
  assert.deepEqual(parseProgress({ step: "environment", done: ["agent", "github", "repos"], runOn: "codex" }), {
    step: "repos",
    done: ["agent", "github", "repos"],
    runOn: "codex",
  });
  assert.equal(parseProgress(null), null);
  assert.equal(parseProgress("repos"), null);
  assert.equal(parseProgress({ step: "done", done: [], runOn: "claude" }), null);
  assert.equal(parseProgress({ step: "repos", done: [], runOn: "gpt" }), null);
  assert.equal(parseProgress({ step: "repos", done: "agent", runOn: "claude" }), null);
});

test("progress is kept per account and org in this browser, and dropped once setup is done", async (t) => {
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
  assert.equal(liveEnv({ ...user, id: "u2" }, org, { outrunnerModels: true }).savedProgress(), null);
  // Another org of theirs is set up apart.
  assert.equal(liveEnv(user, { ...org, id: "o2" }, { outrunnerModels: true }).savedProgress(), null);

  stubFetch({ "POST /api/onboarding/complete": () => [200, { ok: true }] });
  await env().skip();
  assert.equal(env().savedProgress(), null);
  env().saveProgress({ ...progress, done: [...progress.done] });
  await env().finish("env-1", "claude");
  assert.equal(env().savedProgress(), null);
});

test("storage that fails only means setup opens at its start", (t) => {
  const failing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); }, removeItem: () => {} };
  Object.defineProperty(globalThis, "window", { value: { localStorage: failing }, configurable: true });
  t.after(() => {
    delete (globalThis as { window?: unknown }).window;
  });
  assert.doesNotThrow(() => env().saveProgress({ step: "repos", done: [], runOn: "claude" }));
  assert.equal(env().savedProgress(), null);
});
