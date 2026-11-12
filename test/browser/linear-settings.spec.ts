import { expect, test, type Page, type TestInfo } from "@playwright/test";

// The real settings component and work item page, with every API call stubbed:
// no Linear, no database, no sign-in.

const CATALOG = {
  states: [
    { id: "s-backlog", name: "Backlog", type: "backlog" },
    { id: "s-todo", name: "Todo", type: "unstarted" },
    { id: "s-progress", name: "In Progress", type: "started" },
    { id: "s-review", name: "In Review", type: "started" },
    { id: "s-done", name: "Done", type: "completed" },
    { id: "s-canceled", name: "Canceled", type: "canceled" },
    { id: "s-duplicate", name: "Duplicate", type: "duplicate" },
  ],
  labels: [
    { id: "l-bug", name: "Bug" },
    { id: "l-ui", name: "UI" },
  ],
  members: [
    { id: "m-ana", name: "Ana" },
    { id: "m-ben", name: "Ben" },
  ],
};

const TEAMS = [
  { id: "team-eng", key: "ENG", name: "Engineering" },
  { id: "team-ops", key: "OPS", name: "Operations" },
];

async function stub(page: Page) {
  await page.route("**/api/**", (route) => route.fulfill({ json: { missions: [], notifications: [], standings: {}, ids: [], allowance: null } }));
  await page.route("**/api/orgs/org-1/trackers/install-1/teams", (route) => route.fulfill({ json: { teams: TEAMS } }));
  await page.route("**/api/orgs/org-1/trackers/scopes/scope-1", (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: { catalog: CATALOG } }) : route.fulfill({ json: { scope: {} } }),
  );
}

async function open(page: Page, query: string) {
  await stub(page);
  await page.goto(`/settings/org/linear?view=linear&${query}`);
  await expect(page.getByRole("heading", { name: "Linear", exact: true })).toBeVisible();
}

async function shot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: `.context/linear/${name}-${info.project.name}.png`, fullPage: true });
}

async function fitsTheWidth(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test("not connected: an admin can install", async ({ page }, info) => {
  await open(page, "state=none");
  await expect(page.getByText("Not connected.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Install" })).toHaveAttribute("href", "/api/integrations/linear/install");
  await fitsTheWidth(page);
  await shot(page, info, "not-connected");
});

test("not connected: a member is told to ask an admin, with no install", async ({ page }, info) => {
  await open(page, "state=none&role=member");
  await expect(page.getByText("Ask an admin of the org to connect Linear.", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Install" })).toHaveCount(0);
  await shot(page, info, "not-connected-member");
});

test("connected: the team, its rules by name, and its settings", async ({ page }, info) => {
  await open(page, "state=connected");
  await expect(page.getByRole("heading", { name: "Engineering" })).toBeVisible();
  await expect(page.getByText("Labels: Bug or UI · Priority: Urgent or High · Assignee: Unassigned")).toBeVisible();
  await expect(page.getByText("Status: Todo")).toBeVisible();
  await expect(page.getByText("Labels: (removed)")).toBeVisible();
  await expect(page.getByText("→ acme/web")).toBeVisible();
  await expect(page.getByText("→ Unsorted")).toBeVisible();
  await expect(page.getByLabel("Default repository")).toHaveValue("11111111-1111-4111-8111-111111111111");
  await expect(page.getByLabel("State when a session starts")).toHaveValue("s-progress");
  await expect(page.getByLabel("State when its PR opens")).toHaveValue("s-review");
  await expect(page.getByRole("checkbox", { name: /Accept sessions started by Linear rules/ })).not.toBeChecked();
  await expect(page.getByLabel("Most rule-started sessions a day")).toHaveValue("20");
  // Work isn't moved to a closed state.
  await expect(page.getByLabel("State when a session starts").locator("option")).toHaveText(["Session started: no change", "Started: Backlog", "Started: Todo", "Started: In Progress", "Started: In Review"]);
  // A team already connected isn't offered again.
  await expect(page.getByLabel("Team to connect").locator("option")).toHaveText(["Pick a team", "Operations (OPS)"]);
  await fitsTheWidth(page);
  await shot(page, info, "connected");
});

test("a stored state that isn't on offer doesn't read as no change", async ({ page }) => {
  await stub(page);
  // Its PR state is gone from the catalog; the started one isn't loaded until it answers.
  let answer: () => void = () => undefined;
  const loaded = new Promise<void>((resolve) => (answer = resolve));
  await page.route("**/api/orgs/org-1/trackers/scopes/scope-1", async (route) => {
    await loaded;
    await route.fulfill({ json: { catalog: { ...CATALOG, states: CATALOG.states.filter((state) => state.id !== "s-review") } } });
  });
  await page.goto("/settings/org/linear?view=linear&state=connected");
  const review = page.getByLabel("State when its PR opens");
  await expect(review.locator("option:checked")).toHaveText("PR opened: not loaded yet");
  answer();
  await expect(review.locator("option:checked")).toHaveText("PR opened: a state that's gone");
  await expect(review).toHaveValue("s-review");
  await expect(page.getByLabel("State when a session starts").locator("option:checked")).toHaveText("Started: In Progress");
});

test("connected: a change sends what the routes expect", async ({ page }) => {
  await open(page, "state=connected");
  const accept = page.waitForRequest((r) => r.method() === "PATCH" && r.url().endsWith("/trackers/scopes/scope-1"));
  await page.getByRole("checkbox", { name: /Accept sessions started by Linear rules/ }).click();
  expect((await accept).postDataJSON()).toEqual({ acceptRuleSessions: true });
  await expect(page.getByLabel("Default repository")).toBeEnabled();
  const repo = page.waitForRequest((r) => r.method() === "PATCH" && r.url().endsWith("/trackers/scopes/scope-1"));
  await page.getByLabel("Default repository").selectOption({ label: "acme/api" });
  expect((await repo).postDataJSON()).toEqual({ defaultProjectId: "22222222-2222-4222-8222-222222222222" });
  await expect(page.getByLabel("State when its PR opens")).toBeEnabled();
  const state = page.waitForRequest((r) => r.method() === "PATCH" && r.url().endsWith("/trackers/scopes/scope-1"));
  await page.getByLabel("State when its PR opens").selectOption({ label: "PR opened: no change" });
  expect((await state).postDataJSON()).toEqual({ stateMap: { started: "s-progress", inReview: null } });

  await page.route("**/api/orgs/org-1/trackers/install-1/teams", (route) =>
    route.request().method() === "POST" ? route.fulfill({ json: { scope: {} } }) : route.fulfill({ json: { teams: TEAMS } }),
  );
  await page.getByLabel("Team to connect").selectOption("team-ops");
  const connect = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/trackers/install-1/teams"));
  await page.getByRole("button", { name: "Connect team", exact: true }).click();
  expect((await connect).postDataJSON()).toEqual({ teamId: "team-ops" });
});

test("a refusal from the server shows its reason", async ({ page }) => {
  await open(page, "state=connected");
  await page.route("**/api/orgs/org-1/trackers/install-1/teams", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 409, json: { error: "That team is already connected to an org." } })
      : route.fulfill({ json: { teams: TEAMS } }),
  );
  await page.getByLabel("Team to connect").selectOption("team-ops");
  await page.getByRole("button", { name: "Connect team", exact: true }).click();
  await expect(page.getByText("That team is already connected to an org.")).toBeVisible();
});

test("a stopped rule says so, and how to fix it", async ({ page }, info) => {
  await open(page, "state=stopped");
  await expect(page.getByText("Stopped: whoever set this rule has left, or can't file there.", { exact: false })).toBeVisible();
  await expect(page.getByText("Edit and save it to take it on.", { exact: false })).toBeVisible();
  await fitsTheWidth(page);
  await shot(page, info, "stopped-rule");
});

test("a member is told a stopped rule needs an admin", async ({ page }) => {
  await open(page, "state=stopped&role=member");
  await expect(page.getByText("Ask an admin to take it on.", { exact: false })).toBeVisible();
});

test("a disconnected workspace says rules have stopped, and offers Reconnect", async ({ page }, info) => {
  // Linear can't be asked anything for it, so nothing is: the real route would refuse.
  const asked: string[] = [];
  page.on("request", (r) => asked.push(r.url()));
  await open(page, "state=disconnected");
  expect(asked.some((url) => url.includes("/trackers/scopes/scope-1"))).toBe(false);
  await expect(page.getByText("Reconnect to see this team's labels, statuses and people.")).toBeVisible();
  // What's known without Linear reads as names; the rest says how many, never "…".
  await expect(page.getByText("Labels: 2 picked · Priority: Urgent or High · Assignee: Unassigned")).toBeVisible();
  await expect(page.getByText("…")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add rule" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Edit", exact: true }).first()).toBeDisabled();
  await expect(page.getByText("Disconnected: rules have stopped")).toBeVisible();
  await expect(page.getByRole("link", { name: "Reconnect" })).toHaveAttribute("href", "/api/integrations/linear/install");
  // Nothing can be connected to a workspace that isn't connected.
  await expect(page.getByLabel("Team to connect")).toHaveCount(0);
  await fitsTheWidth(page);
  await shot(page, info, "disconnected");
});

for (const [name, status, error] of [
  ["Linear down", 502, "Linear isn't answering. Try again."],
  ["the team gone from Linear", 404, "Linear doesn't show this team to Outrunner."],
  ["disconnected since the page loaded", 409, "This workspace is disconnected. Reconnect it first."],
] as const) {
  test(`when the team can't be read (${name}) it says why, and doesn't offer to edit blind`, async ({ page }, info) => {
    await stub(page);
    await page.route("**/api/orgs/org-1/trackers/scopes/scope-1", (route) => route.fulfill({ status, json: { error } }));
    await page.goto("/settings/org/linear?view=linear&state=connected");
    await expect(page.getByText(error, { exact: false })).toBeVisible();
    await expect(page.getByText("Rules still run, but can't be added or edited until it loads.", { exact: false })).toBeVisible();
    await expect(page.getByText("Labels: 2 picked · Priority: Urgent or High · Assignee: Unassigned")).toBeVisible();
    await expect(page.getByText("…")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add rule" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Edit", exact: true }).first()).toBeDisabled();
    await fitsTheWidth(page);
    if (status === 502) await shot(page, info, "linear-down");
  });
}

test("the Integrations card shows Linear's mark, and says when its connection is lost", async ({ page }, info) => {
  await stub(page);
  await page.goto("/settings/org/integrations?view=linear-card&state=disconnected");
  await expect(page.getByText("Disconnected: rules have stopped. Reconnect it.")).toBeVisible();
  await expect(page.getByText("Connected", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Acme")).toBeVisible();
  await fitsTheWidth(page);
  await shot(page, info, "card-disconnected");
  await page.goto("/settings/org/integrations?view=linear-card&state=connected");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByText("Disconnected: rules have stopped.", { exact: false })).toHaveCount(0);
  await shot(page, info, "card-connected");
});

test("on a deployment with no Linear app, the card tells an admin why there's nothing to do", async ({ page }, info) => {
  await stub(page);
  await page.goto("/settings/org/integrations?view=linear-card&state=unset");
  await expect(page.getByText(/Not set up on this deployment yet/)).toBeVisible();
  await expect(page.getByText(/docs\/linear-app\.md/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Linear/ })).toHaveCount(0);
  await expect(page.getByText("Connected", { exact: true })).toHaveCount(0);
  await fitsTheWidth(page);
  await shot(page, info, "card-unset");
});

test("a member sees everything, and can change nothing", async ({ page }, info) => {
  // Their browser never asks for the team list, which is an admin's.
  const asked: string[] = [];
  page.on("request", (r) => asked.push(r.url()));
  await open(page, "state=connected&role=member");
  await expect(page.getByRole("heading", { name: "Engineering" })).toBeVisible();
  await expect(page.getByText("Labels: Bug or UI", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Default repository")).toBeDisabled();
  await expect(page.getByLabel("State when a session starts")).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: /Accept sessions started by Linear rules/ })).toBeDisabled();
  await expect(page.getByLabel("Most rule-started sessions a day")).toBeDisabled();
  for (const name of ["Add rule", "Edit", "Move up", "Remove rule", "Connect team", "Hold to disconnect", "Hold to disconnect team"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByLabel("Team to connect")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Connect another workspace" })).toHaveCount(0);
  expect(asked.some((url) => url.endsWith("/trackers/install-1/teams"))).toBe(false);
  await fitsTheWidth(page);
  await shot(page, info, "member");
});

test("the rule form offers the team's values, not closed states, and sends ids", async ({ page }, info) => {
  await open(page, "state=connected");
  await page.getByRole("button", { name: "Add rule" }).click();
  const form = page.locator("details");
  for (const label of ["Labels", "Status", "Priority", "Assignee"]) await form.filter({ hasText: label }).locator("summary").click();

  const status = form.filter({ hasText: "Status" });
  for (const open of ["Backlog", "Todo", "In Progress", "In Review"]) await expect(status.getByText(open, { exact: true })).toBeVisible();
  // A closed issue is never filed, so a rule on a closed state would never match.
  await expect(status.getByText("Done", { exact: true })).toHaveCount(0);
  await expect(status.getByText("Canceled", { exact: true })).toHaveCount(0);
  await expect(status.getByText("Duplicate", { exact: true })).toHaveCount(0);

  await expect(form.filter({ hasText: "Priority" }).getByText("Urgent")).toBeVisible();
  await expect(form.filter({ hasText: "Assignee" }).getByText("Unassigned")).toBeVisible();
  await expect(form.filter({ hasText: "Assignee" }).getByText("Ana")).toBeVisible();
  // Linear has no issue types.
  await expect(form.filter({ hasText: "Issue type" })).toHaveCount(0);
  await fitsTheWidth(page);
  await shot(page, info, "rule-form");

  await form.filter({ hasText: "Labels" }).getByRole("checkbox", { name: "Bug" }).check();
  await status.getByRole("checkbox", { name: "Todo" }).check();
  await form.filter({ hasText: "Assignee" }).getByRole("checkbox", { name: "Unassigned" }).check();
  await page.getByLabel("Where it files").selectOption({ label: "File to acme/api" });
  await page.route("**/api/orgs/org-1/trackers/scopes/scope-1/rules", (route) => route.fulfill({ json: { rule: {} } }));
  const save = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/trackers/scopes/scope-1/rules"));
  await page.locator("div.space-y-3").getByRole("button", { name: "Add rule", exact: true }).last().click();
  expect((await save).postDataJSON()).toEqual({
    labels: ["l-bug"],
    states: ["s-todo"],
    priorities: [],
    assignees: ["unassigned"],
    issueTypes: [],
    projectId: "22222222-2222-4222-8222-222222222222",
  });
});

test("editing a rule keeps a removed label visible, so it can be unticked", async ({ page }) => {
  await open(page, "state=connected");
  await page.getByRole("button", { name: "Edit", exact: true }).nth(2).click();
  const labels = page.locator("details").filter({ hasText: "Labels" });
  await labels.locator("summary").click();
  await expect(labels.getByRole("checkbox", { name: "(removed)" })).toBeChecked();
});

test("the app is dark whatever the system asks for: there's no light palette to check", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, "state=connected");
  await expect(page.locator("html")).toHaveClass(/dark/);
});

// --- A work item that follows a tracker -------------------------------------

async function openItem(page: Page, source: "linear" | "app") {
  await stub(page);
  const item = {
    id: "item-1",
    number: 12,
    projectId: null,
    title: "Checkout breaks on Safari",
    body: "Steps in the issue.",
    status: "triage",
    source,
    sourceUrl: source === "linear" ? "https://linear.app/acme/issue/ENG-1" : null,
    sourceRef: source === "linear" ? "linear:issue-1" : null,
    sourceAuthor: source === "linear" ? "Ana" : null,
    duplicateOf: null,
    workspaceId: null,
    prompt: null,
    triagedAt: null,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    can: { triage: true, contribute: true },
  };
  const notes =
    source === "linear"
      ? [{ id: "n1", itemId: "item-1", body: "Seen on iOS too.", source: "linear", sourceUrl: "https://linear.app/acme/issue/ENG-1#c", author: "Ben", createdAt: "2026-11-02T00:00:00Z" }]
      : [];
  await page.route("**/api/triage/items/item-1", (route) => route.fulfill({ json: { item, notes } }));
  await page.goto(`/triage?view=tracker-item&source=${source}`);
  await expect(page.getByLabel("Title")).toHaveValue("Checkout breaks on Safari");
}

test("a Linear item's title and description are read-only, and it says who wrote it", async ({ page }, info) => {
  await openItem(page, "linear");
  await expect(page.getByLabel("Title")).toBeDisabled();
  await page.getByText("Steps in the issue.").hover();
  await expect(page.getByRole("button", { name: "Edit description" })).toHaveCount(0);
  await expect(page.getByText("by Ana", { exact: false })).toBeVisible();
  await expect(page.getByText("Ben", { exact: true })).toBeVisible();
  await expect(page.getByText("via Linear")).toBeVisible();
  await expect(page.getByText("Linear via Linear")).toHaveCount(0);
  // A note here doesn't reach Linear, and it says so where you'd type it.
  await expect(page.getByLabel("Add a note")).toHaveAttribute("placeholder", "Leave a note, not sent to Linear…");
  await fitsTheWidth(page);
  await shot(page, info, "tracker-item");
});

test("the org's own item stays editable on the same page", async ({ page }) => {
  await openItem(page, "app");
  await expect(page.getByLabel("Title")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Edit description" })).toBeAttached();
  await expect(page.getByLabel("Add a note")).toHaveAttribute("placeholder", "Leave a note…");
});
