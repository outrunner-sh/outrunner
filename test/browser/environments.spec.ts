import { expect, test, type Page } from "@playwright/test";

import { stubSelectionApis } from "./selection-api-fixture";
import { project } from "./fixtures";

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
const web = { ...project, id: "project-web", githubRepoId: 11, fullName: "outrunner-sh/web", name: "web" };

/** The APIs the Environments page calls, answered here; what it sent kept. */
async function stubEnvironmentApis(page: Page) {
  const writes: { path: string; body: unknown }[] = [];
  await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // The page's own writes, not the frame's (its sessions' background calls).
    if (request.method() !== "GET" && (path.startsWith("/api/projects/") || path.startsWith("/api/environments"))) {
      writes.push({ path, body: request.postData() ? request.postDataJSON() : null });
    }
    if (path === "/api/github/repositories") {
      return route.fulfill({
        json: {
          repositories: [listing(1, project.fullName), listing(11, web.fullName)],
          connected: [1],
          complete: true,
          ssoPartialOrgIds: [],
          source: { kind: "app", accounts: [{ installationId: 42, login: "outrunner-sh", type: "Organization", suspended: false }] },
        },
      });
    }
    // The frame's own reads.
    if (path === "/api/missions") return route.fulfill({ json: { missions: [] } });
    if (path === "/api/notifications") return route.fulfill({ json: { notifications: [], now: new Date().toISOString(), kinds: [] } });
    if (path.includes("standing")) return route.fulfill({ json: { standings: {}, ids: [] } });
    if (path === "/api/projects/sync") return route.fulfill({ json: { synced: 1, discovered: 1, complete: true, projects: [project, web] } });
    if (path === "/api/environments/env-acme/repos") return route.fulfill({ json: { id: "env-acme" } });
    if (path === "/api/environments") return route.fulfill({ status: 201, json: { id: "env-new" } });
    return route.fulfill({ json: {} });
  });
  return writes;
}

async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByTestId("fixture-ready")).toHaveAttribute("data-ready", "true");
}

test("Pick repositories opens the picker on the org's default environment, and adds the picks to it", async ({ page }) => {
  const writes = await stubEnvironmentApis(page);
  await open(page, "/environments?view=environments&pick=1");
  await expect(page.getByRole("heading", { name: "Add repositories to Acme" })).toBeVisible();
  // In the environment already: ticked, not picked again.
  const own = page.getByRole("checkbox", { name: /outrunner-sh\/outrunner/ });
  await expect(own).toBeChecked();
  await expect(own).toBeDisabled();
  await page.getByRole("checkbox", { name: /outrunner-sh\/web/ }).click();
  await page.getByRole("button", { name: "Add to Acme", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Add repositories to Acme" })).toHaveCount(0);
  // Connected by its id, never every repository; then put in the environment.
  expect(writes).toEqual([
    { path: "/api/projects/sync", body: { repoIds: [11] } },
    { path: "/api/environments/env-acme/repos", body: { projectIds: ["project-web"] } },
  ]);
  // Nothing offers to sync every repository any more.
  await expect(page.getByRole("button", { name: /Sync/ })).toHaveCount(0);
});

test("with no default environment, an admin's picks make the org's first, named after it", async ({ page }) => {
  const writes = await stubEnvironmentApis(page);
  await open(page, "/environments?view=environments&state=no-default&pick=1");
  await expect(page.getByRole("heading", { name: "New environment" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Environment name" })).toHaveValue("neev ai");
  await page.getByRole("checkbox", { name: /outrunner-sh\/outrunner/ }).click();
  await page.getByRole("checkbox", { name: /outrunner-sh\/web/ }).click();
  await page.getByRole("button", { name: "Create environment", exact: true }).click();
  await expect.poll(() => writes.map((w) => w.path)).toEqual(["/api/projects/sync", "/api/environments"]);
  expect(writes[0].body).toEqual({ repoIds: [1, 11] });
  expect(writes[1].body).toEqual({ name: "neev ai", projectIds: ["project-1", "project-web"], orgDefault: true });
});

test("a member's new environment isn't made the org's default, and needs a name first", async ({ page }) => {
  const writes = await stubEnvironmentApis(page);
  await open(page, "/environments?view=environments&state=no-default&role=member");
  await page.getByRole("button", { name: "New environment" }).click();
  await page.getByRole("checkbox", { name: /outrunner-sh\/web/ }).click();
  const create = page.getByRole("button", { name: "Create environment", exact: true });
  await expect(create).toBeEnabled();
  await page.getByRole("textbox", { name: "Environment name" }).fill("   ");
  await expect(create).toBeDisabled();
  await page.getByRole("textbox", { name: "Environment name" }).fill("Web");
  await create.click();
  await expect.poll(() => writes.at(-1)).toEqual({ path: "/api/environments", body: { name: "Web", projectIds: ["project-web"] } });
});

test("the new-session form starts on the org's default environment and sends it with the session", async ({ page }) => {
  const state = await stubSelectionApis(page);
  await open(page, "/new?state=environments");
  await expect(page.getByRole("button", { name: /^Acme/ })).toBeVisible();
  await page.getByRole("textbox", { name: /^Message/ }).fill("Start from the environment");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces\//);
  await expect
    .poll(() => state.evidence.find((e) => (e as { stage: string }).stage === "client request"))
    .toMatchObject({ path: "/api/projects/project-1/workspaces", body: { environmentId: "env-acme" } });
});

test("picking a repository instead starts from the repository's own environment", async ({ page }) => {
  const state = await stubSelectionApis(page);
  await page.route("**/api/github/repositories", (route) =>
    route.fulfill({ json: { repositories: [listing(1, project.fullName)], connected: [1], complete: true, ssoPartialOrgIds: [], source: { kind: "user" } } }),
  );
  await open(page, "/new?state=environments");
  await page.getByRole("button", { name: /^Acme/ }).click();
  await expect(page.getByRole("option", { name: /Acme/ })).toBeVisible();
  await page.getByRole("option", { name: /outrunner-sh\/outrunner/ }).click();
  await page.getByRole("textbox", { name: /^Message/ }).fill("Start from the repository");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(() => state.evidence.find((e) => (e as { stage: string }).stage === "client request"))
    .toMatchObject({ path: "/api/projects/project-1/workspaces" });
  const sent = state.evidence.find((e) => (e as { stage: string }).stage === "client request") as { body: Record<string, unknown> };
  expect(sent.body.environmentId).toBeUndefined();
});
