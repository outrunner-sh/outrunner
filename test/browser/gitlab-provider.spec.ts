import { expect, test } from "@playwright/test";

const repo = { githubRepoId: null, provider: "gitlab", repositoryId: 1, fullName: "gitlab.com/acme/platform/app", owner: "acme/platform", name: "app", ownerType: null, avatarUrl: null, private: true, language: null, description: null, pushedAt: null };

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/gitlab/connection") return route.fulfill({ json: { connection: request.method() === "DELETE" ? null : { login: "ada", updatedAt: new Date().toISOString() } } });
    if (path === "/api/gitlab/repositories") return route.fulfill({ json: { repositories: [repo], complete: true, connected: [] } });
    if (path === "/api/github/repositories") return route.fulfill({ json: { repositories: [{ ...repo, provider: "github", githubRepoId: 1, repositoryId: undefined, fullName: "acme/app" }], complete: true } });
    if (path === "/api/gitlab/projects") return route.fulfill({ json: { projects: [{ ...repo, id: "gitlab-project", orgId: "org-1", defaultBranch: "main", htmlUrl: "https://gitlab.com/acme/platform/app", linearIssueIds: [], createdAt: "", updatedAt: "" }] } });
    return route.fulfill({ json: { missions: [], notifications: [], standings: {}, ids: [], allowance: null } });
  });
});

test("connect, replace and disconnect a GitLab token without displaying it", async ({ page }) => {
  await page.goto("/gitlab");
  await expect(page.getByTestId("gitlab-fixture")).toHaveAttribute("data-ready", "true");
  const token = page.getByLabel("GitLab personal access token");
  await expect(token).toHaveAttribute("type", "password");
  await token.fill("glpat_fixture_token");
  await page.getByRole("button", { name: "Connect GitLab", exact: true }).click();
  await expect(page.getByText("Connected as @ada")).toBeVisible();
  await expect(token).toHaveCount(0);
  await page.getByRole("button", { name: "Replace token", exact: true }).click();
  await expect(token).toHaveValue("");
  await page.getByRole("button", { name: "Disconnect GitLab" }).click();
  await expect(page.getByRole("button", { name: "Connect GitLab", exact: true })).toBeVisible();
});

test("switch from GitHub to GitLab, search a subgroup and connect it using its provider id", async ({ page }) => {
  await page.goto("/gitlab?state=connected");
  await expect(page.getByTestId("gitlab-fixture")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Select repository…" }).click();
  await expect(page.getByRole("option", { name: "acme/app" })).toBeVisible();
  await page.getByRole("button", { name: "GitLab", exact: true }).click();
  await page.getByRole("combobox", { name: "Search repositories" }).fill("platform");
  const request = page.waitForRequest((request) => request.url().endsWith("/api/gitlab/projects"));
  await page.getByRole("option", { name: repo.fullName }).click();
  expect((await request).postDataJSON()).toEqual({ repoId: 1 });
  await expect(page.getByRole("status")).toHaveText(`Selected ${repo.fullName}`);
});

test("a revoked GitLab token shows its own connection recovery link", async ({ page }) => {
  await page.route("**/api/gitlab/repositories", (route) => route.fulfill({ status: 409, json: { error: "Reconnect GitLab in Settings → Connections." } }));
  await page.goto("/gitlab?state=connected");
  await expect(page.getByTestId("gitlab-fixture")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Select repository…" }).click();
  await page.getByRole("button", { name: "GitLab", exact: true }).click();
  await expect(page.getByRole("link", { name: "Connect GitLab", exact: true })).toHaveAttribute("href", "/settings/connections");
  await expect(page.getByText("Reconnect GitLab in Settings → Connections.")).toBeVisible();
});
