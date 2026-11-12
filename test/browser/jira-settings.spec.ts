import { expect, test, type Page } from "@playwright/test";

// The real settings component on Jira's words and catalog, with every API call stubbed: no
// Jira, no database, no sign-in.

const CATALOG = {
  states: [
    { id: "1", name: "To Do", type: "unstarted" },
    { id: "3", name: "In Progress", type: "started" },
    { id: "4", name: "In Review", type: "started" },
    { id: "5", name: "Done", type: "completed" },
  ],
  labels: [{ id: "bug", name: "bug" }],
  priorities: [
    { id: "1", name: "Highest" },
    { id: "2", name: "High" },
  ],
  issueTypes: [
    { id: "10001", name: "Bug" },
    { id: "10002", name: "Task" },
  ],
  members: [{ id: "acc-ana", name: "Ana" }],
};

async function open(page: Page, query: string) {
  await page.route("**/api/**", (route) => route.fulfill({ json: { missions: [], notifications: [], standings: {}, ids: [], allowance: null } }));
  await page.route("**/api/orgs/org-1/trackers/install-1/teams", (route) =>
    route.fulfill({ json: { teams: [{ id: "10000", key: "ENG", name: "Engineering" }, { id: "10001", key: "OPS", name: "Operations" }] } }),
  );
  await page.route("**/api/orgs/org-1/trackers/scopes/scope-1", (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: { catalog: CATALOG } }) : route.fulfill({ json: { scope: {} } }),
  );
  await page.goto(`/settings/org/jira?view=jira&${query}`);
  await expect(page.getByRole("heading", { name: "Jira", exact: true })).toBeVisible();
}

test("not connected: an admin can install it from Jira's route", async ({ page }) => {
  await open(page, "state=none");
  await expect(page.getByRole("link", { name: "Install" })).toHaveAttribute("href", "/api/integrations/jira/install");
});

test("connected: it speaks of projects and Jira, never teams or Linear", async ({ page }) => {
  await open(page, "state=connected");
  await expect(page.getByLabel("Project to connect")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect project", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Accept sessions started by Jira rules/ })).toBeVisible();
  const body = (await page.locator("section").first().innerText()).toLowerCase();
  expect(body).not.toContain("linear");
  expect(body).not.toContain("team");
});

test("it says who it's connected as, and warns before anyone authorizes as themselves", async ({ page }) => {
  await open(page, "state=connected");
  await expect(page.getByText("Connected as Outrunner Bot. Issues assigned to or mentioning this account start sessions.")).toBeVisible();
  await expect(page.getByText(/webhook isn't active/)).toHaveCount(0);
  await open(page, "state=none");
  await expect(page.getByText(/Authorize as a dedicated Outrunner account on one site, not your own/)).toBeVisible();
});

test("a webhook that's not active says nothing is arriving", async ({ page }) => {
  await open(page, "state=no-webhook");
  await expect(page.getByText(/webhook isn't active, so nothing is arriving from this site/)).toBeVisible();
});

test("connected: a rule names Jira's own priorities and issue types", async ({ page }) => {
  await open(page, "state=connected");
  await expect(page.getByText("Priority: Highest")).toBeVisible();
  await expect(page.getByText("Issue type: Bug")).toBeVisible();
  // A done status isn't somewhere work moves to.
  await expect(page.getByLabel("State when a session starts").locator("option")).toHaveText(["Session started: no change", "Started: To Do", "Started: In Progress", "Started: In Review"]);
});

test("adding a rule sends its issue types", async ({ page }) => {
  await open(page, "state=connected");
  await page.getByRole("button", { name: "Add rule" }).click();
  await page.locator("summary", { hasText: "Issue type" }).click();
  await page.getByRole("checkbox", { name: "Task" }).check();
  const sent = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/trackers/scopes/scope-1/rules"));
  await page.getByRole("button", { name: "Add rule" }).click();
  expect((await sent).postDataJSON()).toMatchObject({ issueTypes: ["10002"] });
});

test("disconnected: Reconnect goes back through Jira's install", async ({ page }) => {
  await open(page, "state=disconnected");
  await expect(page.getByRole("link", { name: "Reconnect" })).toHaveAttribute("href", "/api/integrations/jira/install");
});
