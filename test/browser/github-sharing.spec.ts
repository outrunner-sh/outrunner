import { expect, test } from "@playwright/test";

test("an existing GitHub installation can be added to the active organization", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: { missions: [], notifications: [], standings: {}, ids: [], allowance: null } }));
  await page.route("**/api/orgs/org-1/github/installations", (route) => route.fulfill({ json: { claimed: 42 } }));
  await page.goto("/settings/org/github?view=github");
  await expect(page.getByRole("heading", { name: "Available GitHub connections" })).toBeVisible();
  await expect(page.getByText("outrunner-sh", { exact: true })).toBeVisible();
  const request = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/api/orgs/org-1/github/installations"));
  await page.getByRole("button", { name: "Add to acme" }).click();
  expect((await request).postDataJSON()).toEqual({ installationId: 42 });
  // Its repositories are picked next, not all added.
  await expect(page.getByText("Added outrunner-sh. Next, pick which of its repositories to work on.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Pick repositories" })).toHaveAttribute("href", "/environments");
  await expect(page.getByRole("button", { name: "Add to acme" })).toBeEnabled();
  await expect(page.getByText("Multiple Outrunner organizations can share the same GitHub App installation.", { exact: false })).toBeVisible();
});

test("members cannot add shared installations", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: { missions: [], notifications: [], standings: {}, ids: [], allowance: null } }));
  await page.goto("/settings/org/github?view=github&state=member");
  await expect(page.getByText("Only the org's admins install the GitHub App.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to acme" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Install the GitHub App" })).toHaveCount(0);
});

test("the source org sees the orgs its installation is shared with, and can stop sharing", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: { missions: [], notifications: [], standings: {}, ids: [], allowance: null } }));
  await page.goto("/settings/org/github?view=github&state=connected&shared=1");
  await expect(page.getByText("Also shared with")).toBeVisible();
  await expect(page.getByText("Personal (personal org)")).toBeVisible();
  await expect(page.getByText("by alan@acme.dev", { exact: false })).toBeVisible();
  // Removing it here wouldn't cut the share off: it says so before anyone does.
  await expect(page.getByText("Removing outrunner-sh from acme leaves this org connected", { exact: false })).toBeVisible();
  const request = page.waitForRequest(
    (r) => r.method() === "DELETE" && r.url().endsWith("/api/orgs/org-1/github/installations/42/shares/00000000-0000-4000-a000-000000000077"),
  );
  const stop = page.getByRole("button", { name: "Hold to stop sharing" });
  await stop.focus();
  await page.keyboard.down("Enter");
  await request;
  await page.keyboard.up("Enter");
});

test("an installation shared with no one says so", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: { missions: [], notifications: [], standings: {}, ids: [], allowance: null } }));
  await page.goto("/settings/org/github?view=github&state=connected");
  await expect(page.getByText("Not shared with any other Outrunner org.")).toBeVisible();
  await expect(page.getByText("leaves this org connected", { exact: false })).toHaveCount(0);
});

test("an installation changed on GitHub, not yet the org's, is offered to add with a click", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: { missions: [], notifications: [], standings: {}, ids: [], allowance: null } }));
  await page.route("**/api/orgs/org-1/github/installations", (route) => route.fulfill({ json: { claimed: 42 } }));
  await page.goto("/settings/org/github?view=github&offer=1");
  await expect(page.getByText("outrunner-sh was changed on GitHub, but it isn't connected to acme.", { exact: false })).toBeVisible();
  // Offered once: not listed again under Available.
  await expect(page.getByRole("heading", { name: "Available GitHub connections" })).toHaveCount(0);
  const request = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/api/orgs/org-1/github/installations"));
  await page.getByRole("button", { name: "Add to acme" }).click();
  expect((await request).postDataJSON()).toEqual({ installationId: 42 });
  await expect(page.getByText("Added outrunner-sh. Next, pick which of its repositories to work on.")).toBeVisible();
});
