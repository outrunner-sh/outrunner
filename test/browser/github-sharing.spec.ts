import { expect, test } from "@playwright/test";

test("an existing GitHub installation can be added to the active organization", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: { missions: [], notifications: [], standings: {}, ids: [], allowance: null } }));
  await page.goto("/settings/org/github?view=github");
  await expect(page.getByRole("heading", { name: "Available GitHub connections" })).toBeVisible();
  await expect(page.getByText("neevai-labs", { exact: true })).toBeVisible();
  const request = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/api/orgs/org-1/github/installations"));
  await page.getByRole("button", { name: "Add to neevcloud" }).click();
  expect((await request).postDataJSON()).toEqual({ installationId: 42 });
  await expect(page.getByRole("button", { name: "Add to neevcloud" })).toBeEnabled();
  await expect(page.getByText("Multiple Outrunner organizations can share the same GitHub App installation.", { exact: false })).toBeVisible();
});

test("members cannot add shared installations", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: { missions: [], notifications: [], standings: {}, ids: [], allowance: null } }));
  await page.goto("/settings/org/github?view=github&state=member");
  await expect(page.getByText("Only the org's admins install the GitHub App.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to neevcloud" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Install the GitHub App" })).toHaveCount(0);
});

test("a shared connection says how long it lasts", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: { missions: [], notifications: [], standings: {}, ids: [], allowance: null } }));
  await page.goto("/settings/org/github?view=github&state=shared");
  await expect(page.getByText("neevai-labs", { exact: true })).toBeVisible();
  const note = page.getByText("Shared from another org", { exact: true });
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute("title", /stops administering that org/);
});

test("a refused share says why", async ({ page }) => {
  const refusal = "A personal org can't take another org's GitHub connection. Install the App on your own GitHub account instead.";
  await page.route("**/api/**", (route) =>
    route.request().method() === "POST" && route.request().url().endsWith("/github/installations")
      ? route.fulfill({ status: 409, json: { error: refusal, code: "personal_org" } })
      : route.fulfill({ json: { missions: [], notifications: [], standings: {}, ids: [], allowance: null } }),
  );
  await page.goto("/settings/org/github?view=github");
  await page.getByRole("button", { name: "Add to neevcloud" }).click();
  await expect(page.getByText(refusal)).toBeVisible();
});
