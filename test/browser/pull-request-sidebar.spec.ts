import { expect, test, type Page } from "@playwright/test";

const lookup = "**/api/workspaces/pr-fixture/pull-request";
const pullRequest = {
  id: "existing-pr", workspaceId: "pr-fixture", projectId: "project-1",
  number: 343, url: "https://github.com/outrunner-sh/outrunner/pull/343",
  title: "Existing branch pull request", baseBranch: "main", headBranch: "runtime/fixture",
  state: "open", createdAt: "2026-11-15T00:00:00Z",
};
const green = {
  state: "open", draft: false, mergeableState: "clean", headSha: "a".repeat(40),
  checks: { passing: 3, failing: 0, pending: 0 },
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: {
    files: [], previews: [], ports: [], media: [], missions: [], notifications: [], standings: {}, ids: [],
    attachment: { id: "55555555-5555-4555-8555-555555555555" },
  } }));
});

async function expectPullRequest(page: Page) {
  await expect(page.getByRole("link", { name: "#343", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create PR", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Merge", exact: true })).toBeEnabled();
}

test("an existing PR replaces Create PR after the initial branch lookup", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route(lookup, async (route) => {
    await pending;
    await route.fulfill({ json: { pullRequest, status: green } });
  });
  await page.goto("/?view=pr-sidebar");
  await expect(page.getByRole("button", { name: "Create PR", exact: true })).toBeDisabled();
  release();
  await expectPullRequest(page);

  let mergeBody: unknown = null;
  await page.route("**/api/workspaces/pr-fixture/pull-request/merge", async (route) => {
    mergeBody = route.request().postDataJSON();
    await route.fulfill({ json: { merged: true, status: { ...green, state: "merged" } } });
  });
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm merge", exact: true })).toBeVisible();
  expect(mergeBody).toBeNull();
  await page.getByRole("button", { name: "Confirm merge", exact: true }).click();
  await expect(page.getByText("Merged", { exact: true })).toBeVisible();
  expect(mergeBody).toEqual({ headSha: green.headSha });
  await expect(page.getByRole("button", { name: "Review", exact: true })).toHaveCount(0);
});

test("a PR opened outside Create PR is discovered while the sidebar stays open", async ({ page }) => {
  await page.clock.install();
  let opened = false;
  await page.route(lookup, (route) => route.fulfill({ json: opened
    ? { pullRequest, status: green }
    : { pullRequest: null, status: null } }));
  await page.goto("/?view=pr-sidebar");
  await expect(page.getByRole("button", { name: "Create PR", exact: true })).toBeEnabled();
  opened = true;
  await page.clock.fastForward(15_001);
  await expectPullRequest(page);
});

test("a failed initial lookup retries without enabling Create PR blindly", async ({ page }) => {
  await page.clock.install();
  let calls = 0;
  await page.route(lookup, (route) => ++calls === 1
    ? route.fulfill({ status: 503, json: { error: "Temporary failure" } })
    : route.fulfill({ json: { pullRequest, status: green } }));
  await page.goto("/?view=pr-sidebar");
  await expect.poll(() => calls).toBe(1);
  await expect(page.getByRole("button", { name: "Create PR", exact: true })).toBeDisabled();
  await page.clock.fastForward(15_001);
  await expectPullRequest(page);
});

test("returning to the app rechecks a branch that previously had no PR", async ({ page }) => {
  let opened = false;
  await page.route(lookup, (route) => route.fulfill({ json: opened
    ? { pullRequest, status: green }
    : { pullRequest: null, status: null } }));
  await page.goto("/?view=pr-sidebar");
  await expect(page.getByRole("button", { name: "Create PR", exact: true })).toBeEnabled();
  opened = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expectPullRequest(page);
});

test("Review and Merge both show while checks run, with Merge disabled until green", async ({ page }) => {
  await page.clock.install();
  let pending = true;
  await page.route(lookup, (route) => route.fulfill({ json: {
    pullRequest,
    status: pending ? { ...green, checks: { passing: 2, failing: 0, pending: 1 } } : green,
  } }));
  await page.goto("/?view=pr-sidebar");
  await expect(page.getByRole("button", { name: "Review", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Merge", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Merge", exact: true })).toHaveAttribute("title", "Checks are still running.");
  pending = false;
  await page.clock.fastForward(30_001);
  await expectPullRequest(page);
});

test("a renamed branch is checked immediately and ignores the old lookup's result", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  await page.route(lookup, async (route) => {
    if (++calls === 1) {
      await pending;
      await route.fulfill({ json: { pullRequest: { ...pullRequest, number: 342 }, status: green } });
    } else {
      await route.fulfill({ json: { pullRequest, status: green } });
    }
  });
  await page.goto("/?view=pr-sidebar");
  await expect.poll(() => calls).toBe(1);
  await page.getByRole("button", { name: "Rename fixture branch", exact: true }).click();
  await expectPullRequest(page);
  const oldResponse = page.waitForResponse((response) => response.url().endsWith("/pull-request"));
  release();
  await oldResponse;
  await expect(page.getByRole("link", { name: "#342", exact: true })).toHaveCount(0);
  await expectPullRequest(page);
});
