import { expect, test, type Page } from "@playwright/test";

const listing = (githubRepoId: number, fullName: string) => ({
  githubRepoId,
  fullName,
  name: fullName.split("/")[1],
  owner: fullName.split("/")[0],
  ownerType: "Organization",
  avatarUrl: null,
  private: true,
  language: null,
  description: null,
  pushedAt: null,
});
const project = (id: string, githubRepoId: number, fullName: string) => ({
  id,
  githubRepoId,
  fullName,
  owner: fullName.split("/")[0],
  name: fullName.split("/")[1],
  defaultBranch: "main",
  private: true,
  language: null,
  description: null,
  htmlUrl: `https://github.com/${fullName}`,
  pushedAt: null,
  linearIssueIds: [],
  orgId: "org-1",
  createdAt: "",
  updatedAt: "",
});
const gitlabRepo = { provider: "gitlab", repositoryId: 7, githubRepoId: null, fullName: "gitlab.com/acme/platform/app", owner: "acme/platform", name: "app", ownerType: null, avatarUrl: null, private: true, language: null, description: null, pushedAt: null };

/** The APIs setup calls, answered as for a new org, Acme; what it sent kept. */
async function setupApis(page: Page, options: { accounts?: string[]; available?: boolean } = {}) {
  const writes: { path: string; body: unknown }[] = [];
  let accounts = options.accounts ?? ["acme"];
  let gitlab: { login: string; updatedAt: string } | null = null;
  await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== "GET") writes.push({ path, body: request.postData() ? request.postDataJSON() : null });
    if (path === "/api/orgs/org-1/github/installations") {
      accounts = ["acme"];
      return route.fulfill({ json: { claimed: 42 } });
    }
    if (path === "/api/gitlab/connection") {
      if (method === "POST") gitlab = { login: "ada", updatedAt: "2026-11-13T00:00:00Z" };
      return route.fulfill({ json: { connection: gitlab } });
    }
    const answers: Record<string, unknown> = {
      "/api/settings/claude": { connected: false, last4: null },
      "/api/settings/providers": { keys: {} },
      "/api/settings/agents": { choices: { claude: null, codex: null } },
      "/api/onboarding/github": {
        access: {
          admin: true,
          accounts,
          available: options.available && accounts.length === 0 ? [{ id: 42, accountLogin: "acme" }] : [],
          personalGithub: false,
          appInstallable: true,
          installNeedsGithub: false,
        },
      },
      "/api/github/repositories": {
        repositories: [listing(7, "acme/app"), listing(8, "acme/api")],
        connected: [],
        complete: true,
        ssoPartialOrgIds: [],
        source: { kind: "app", accounts: [{ installationId: 42, login: "acme", type: "Organization", suspended: false }] },
      },
      "/api/gitlab/repositories": { repositories: [gitlabRepo], connected: [] },
      "/api/gitlab/projects": { projects: [{ ...project("gitlab-project", 0, "gitlab.com/acme/platform/app"), githubRepoId: null, provider: "gitlab", repositoryId: 7 }] },
      "/api/projects/sync": { projects: [project("p-api", 8, "acme/api"), project("p-app", 7, "acme/app")] },
      "/api/environments": { id: "env-acme" },
      "/api/onboarding/complete": { ok: true },
    };
    return route.fulfill({ status: path === "/api/environments" ? 201 : 200, json: answers[path] ?? {} });
  });
  await page.goto("/setup");
  await page.getByRole("button", { name: /OpenAI Codex/ }).click();
  await page.getByRole("button", { name: /Outrunner.s models/ }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect GitHub" })).toBeVisible();
  return writes;
}

/** Home on the fixture page, with the server's setup answer for `state`. */
async function home(page: Page, state: string) {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/missions") return route.fulfill({ json: { missions: [] } });
    if (path === "/api/notifications") return route.fulfill({ json: { notifications: [], now: new Date().toISOString(), kinds: [] } });
    if (path.includes("standing")) return route.fulfill({ json: { standings: {}, ids: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`/?state=${state}`);
  await expect(page.getByTestId("fixture-ready")).toHaveAttribute("data-ready", "true");
}

test("an admin of an org not set up yet is sent through setup", async ({ page }) => {
  await home(page, "setup-admin");
  await expect(page).toHaveURL(/\/onboarding$/);
});

test("a member of an org not set up yet is told an admin is on it, in place of the form", async ({ page }) => {
  await home(page, "setup-member");
  await expect(page.getByRole("heading", { name: "An admin is setting up Acme" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Connect your coding agent/ })).toHaveAttribute("href", "/settings/coding-agents");
  await expect(page.getByRole("heading", { name: "What would you like to build?" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/\?state=setup-member$/);
});

test("an org that has had a session skips setup: home is the new-session form", async ({ page }) => {
  await home(page, "setup-used");
  await expect(page.getByRole("heading", { name: "What would you like to build?" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /An admin is setting up/ })).toHaveCount(0);
  await expect(page).toHaveURL(/\/\?state=setup-used$/);
});

test("finishing setup makes an environment named after the org of the repositories picked, its default", async ({ page }) => {
  const writes = await setupApis(page);
  await expect(page.getByText("Outrunner's GitHub App on acme.")).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Pick your repositories" })).toBeVisible();
  await page.getByRole("checkbox", { name: /acme\/app/ }).click();
  await page.getByRole("checkbox", { name: /acme\/api/ }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Name your environment" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Environment name" })).toHaveValue("Acme");
  await expect(page.getByRole("list", { name: "Its repositories" })).toContainText("acme/app");
  await page.getByRole("button", { name: "Create environment", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("/new?environment=env-acme&focus=composer&start=codex-outrunner");
  const made = writes.filter((w) => ["/api/projects/sync", "/api/environments", "/api/onboarding/complete"].includes(w.path));
  expect(made).toEqual([
    { path: "/api/projects/sync", body: { repoIds: [7, 8] } },
    // In the order ticked, not as the server lists them.
    { path: "/api/environments", body: { name: "Acme", projectIds: ["p-app", "p-api"], orgDefault: true } },
    { path: "/api/onboarding/complete", body: null },
  ]);
});

test("an installation already on GitHub is added to the org with a click", async ({ page }) => {
  const writes = await setupApis(page, { accounts: [], available: true });
  const next = page.getByRole("button", { name: "Continue", exact: true });
  await expect(next).toBeDisabled();
  await page.getByRole("button", { name: "Add to Acme", exact: true }).click();
  await expect(page.getByText("GitHub is connected")).toBeVisible();
  expect(writes).toContainEqual({ path: "/api/orgs/org-1/github/installations", body: { installationId: 42 } });
  await expect(next).toBeEnabled();
});

test("GitLab instead: connected inline, its repositories picked in the same picker", async ({ page }) => {
  const writes = await setupApis(page, { accounts: [] });
  await page.getByRole("button", { name: "Use GitLab instead" }).click();
  const token = page.getByLabel("GitLab personal access token");
  await expect(token).toHaveAttribute("type", "password");
  await token.fill("glpat_fixture");
  await page.getByRole("button", { name: "Connect GitLab", exact: true }).click();
  await expect(page.getByText("Connected as @ada")).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "GitLab", exact: true }).click();
  await page.getByRole("checkbox", { name: /gitlab.com\/acme\/platform\/app/ }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Create environment", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("/new?environment=env-acme&focus=composer&start=codex-outrunner");
  expect(writes).toContainEqual({ path: "/api/gitlab/projects", body: { repoId: 7 } });
  expect(writes).toContainEqual({ path: "/api/environments", body: { name: "Acme", projectIds: ["gitlab-project"], orgDefault: true } });
  expect(writes.some((w) => w.path === "/api/projects/sync")).toBe(false);
});
