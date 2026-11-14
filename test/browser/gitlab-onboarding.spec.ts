import { expect, test, type Page } from "@playwright/test";

const connection = { login: "ada", updatedAt: "2026-11-13T00:00:00Z" };
const repo = { provider: "gitlab", repositoryId: 7, githubRepoId: null, fullName: "gitlab.com/acme/platform/app", owner: "acme/platform", name: "app", ownerType: null, avatarUrl: null, private: true, language: null, description: "Platform application", pushedAt: null };
const gitlabProject = { ...repo, id: "gitlab-project", orgId: "personal", defaultBranch: "main", htmlUrl: "https://gitlab.com/acme/platform/app", linearIssueIds: [], createdAt: "", updatedAt: "" };

async function setup(page: Page, options: { connected?: boolean; github?: boolean } = {}) {
  let connected = options.connected ?? false;
  const writes: { path: string; body: unknown }[] = [];
  await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== "GET") writes.push({ path, body: request.postData() ? request.postDataJSON() : null });
    if (path === "/api/gitlab/connection") {
      if (method === "POST") connected = true;
      if (method === "DELETE") connected = false;
      return route.fulfill({ json: { connection: connected ? connection : null } });
    }
    const answers: Record<string, unknown> = {
      "/api/settings/claude": { connected: false, last4: null },
      "/api/settings/providers": { keys: {} },
      "/api/settings/agents": { choices: { claude: null, codex: null } },
      "/api/onboarding/github": { access: { orgs: [{ id: "personal", name: "Personal", personal: true, admin: true, accounts: [] }], activeOrgId: "personal", personalGithub: options.github ?? false, appInstallable: true, installNeedsGithub: false, personalConnectable: true } },
      "/api/github/repositories": { repositories: [{ ...repo, provider: "github", repositoryId: undefined, githubRepoId: 7, fullName: "acme/app" }], connected: [] },
      "/api/gitlab/repositories": { repositories: [repo], connected: [] },
      // Same numeric id on GitHub comes first: Finish must select GitLab.
      "/api/gitlab/projects": { projects: [{ ...gitlabProject, id: "github-project", provider: "github", repositoryId: undefined, githubRepoId: 7 }, gitlabProject] },
      "/api/projects/sync": { projects: [{ ...gitlabProject, id: "github-project", provider: "github", repositoryId: undefined, githubRepoId: 7, fullName: "acme/app" }] },
      "/api/onboarding/complete": { ok: true },
    };
    return route.fulfill({ json: answers[path] ?? {} });
  });
  await page.goto("/gitlab?view=onboarding");
  await page.getByRole("button", { name: /OpenAI Codex/ }).click();
  await page.getByRole("button", { name: /Outrunner.s models/ }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Pick your repositories" })).toBeVisible();
  return writes;
}

test("GitLab-only users connect inline and finish onboarding on the GitLab project and chosen agent", async ({ page }) => {
  const writes = await setup(page);
  await expect(page.getByRole("button", { name: "Finish", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "GitLab", exact: true }).click();
  const token = page.getByLabel("GitLab personal access token");
  await expect(token).toHaveAttribute("type", "password");
  await token.fill("glpat_fixture");
  await page.getByRole("button", { name: "Connect GitLab", exact: true }).click();
  await expect(token).toHaveCount(0);
  await expect(page.getByText("Connected as @ada")).toBeVisible();
  await page.getByRole("textbox", { name: "Search repositories" }).fill("platform");
  await page.getByRole("checkbox", { name: /gitlab.com\/acme\/platform\/app/ }).check();
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Onboarding complete" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("/new?project=gitlab-project&focus=composer&start=codex-outrunner");
  expect(writes).toContainEqual({ path: "/api/gitlab/projects", body: { repoId: 7 } });
  expect(writes).toContainEqual({ path: "/api/onboarding/complete", body: null });
  expect(writes.some((write) => write.path === "/api/projects/sync")).toBe(false);
});

test("switching provider clears selections even when GitHub and GitLab ids match", async ({ page }) => {
  await setup(page, { connected: true, github: true });
  await page.getByRole("checkbox", { name: /acme\/app/ }).check();
  await expect(page.getByRole("button", { name: "Finish", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "GitLab", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /gitlab.com\/acme\/platform\/app/ })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Finish", exact: true })).toBeDisabled();
  await expect(page.getByLabel("GitLab personal access token")).toHaveCount(0);
  await page.getByRole("checkbox", { name: /gitlab.com\/acme\/platform\/app/ }).check();
  await page.getByRole("button", { name: "GitHub", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /acme\/app/ })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Finish", exact: true })).toBeDisabled();
});

test("a rejected token can be corrected without leaving onboarding", async ({ page }) => {
  await setup(page);
  let refused = true;
  await page.route("**/api/gitlab/connection", (route) => route.fulfill(route.request().method() === "GET" ? { json: { connection: null } } : refused ? { status: 409, json: { error: "GitLab token expired. Replace it and try again." } } : { json: { connection } }));
  await page.getByRole("button", { name: "GitLab", exact: true }).click();
  const token = page.getByLabel("GitLab personal access token");
  await token.fill("expired_fixture");
  await page.getByRole("button", { name: "Connect GitLab", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "GitLab token expired" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Finish", exact: true })).toBeDisabled();
  refused = false;
  await token.fill("valid_fixture");
  await page.getByRole("button", { name: "Connect GitLab", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /gitlab.com\/acme\/platform\/app/ })).toBeVisible();
});

test("GitHub onboarding still finishes through the existing sync route", async ({ page }) => {
  const writes = await setup(page, { github: true });
  await page.getByRole("checkbox", { name: /acme\/app/ }).check();
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("/new?project=github-project&focus=composer&start=codex-outrunner");
  expect(writes).toContainEqual({ path: "/api/projects/sync", body: { repoIds: [7] } });
  expect(writes.some((write) => write.path === "/api/gitlab/projects")).toBe(false);
});

test("a GitLab save that finishes after switching back leaves the GitHub selection intact", async ({ page }) => {
  await setup(page, { github: true });
  let complete: (() => Promise<void>) | undefined;
  await page.route("**/api/gitlab/connection", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await new Promise<void>((resolve) => {
      complete = async () => { await route.fulfill({ json: { connection } }); resolve(); };
    });
  });
  await page.getByRole("button", { name: "GitLab", exact: true }).click();
  await page.getByLabel("GitLab personal access token").fill("glpat_fixture");
  await page.getByRole("button", { name: "Connect GitLab", exact: true }).click();
  await expect.poll(() => Boolean(complete)).toBe(true);
  await page.getByRole("button", { name: "GitHub", exact: true }).click();
  const github = page.getByRole("checkbox", { name: /acme\/app/ });
  await github.check();
  await complete!();
  await expect(github).toBeChecked();
  await expect(page.getByRole("button", { name: "Finish", exact: true })).toBeEnabled();
});
