import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

import { environment, frame, pull } from "./fixtures";

async function stubApis(page: Page) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown = {};
    let status = 200;
    if (path === "/api/outrunner-models")
      body = {
        outrunner: true,
        allowance: true,
        available: true,
        keys: [],
        harnesses: ["claude", "codex"],
        codexModels: [],
        loadout: { models: [], default: null },
        agents: {
          claude: { cloud: true, local: false },
          codex: { cloud: true, local: false },
        },
      };
    else if (path === "/api/outrunner-models/usage") body = { allowance: null };
    else if (path === "/api/missions") body = { missions: [] };
    else if (path === "/api/notifications")
      body = { notifications: [], now: new Date().toISOString(), kinds: [] };
    else if (path === "/api/prompt-history")
      body = { prompts: [], owner: "preview-owner" };
    else if (path.includes("standing"))
      body = {
        standings: {},
        ids: frame.appData.workspaces.map((workspace) => workspace.id),
      };
    else if (path === "/api/review/ask")
      body = {
        answer: "Archive preserves every conversation in the snapshot.",
      };
    else if (path === "/api/review/change" && request.method() === "POST")
      body = {
        kind: "sent",
        sessionId: "preview-session",
        own: true,
        since: pull.headSha,
        askedAt: new Date().toISOString(),
      };
    else if (path === "/api/review/change")
      body = {
        status: "running",
        working: true,
        waiting: null,
        reply: null,
        repliedAt: null,
        headSha: pull.headSha,
        commits: [],
      };
    else if (path === "/api/review/tour")
      body = {
        headSha: pull.headSha,
        tour: {
          summary: "Review the archive change.",
          steps: [
            {
              hunkId: "lib/session/archive.ts#0",
              path: "lib/session/archive.ts",
              title: "Preserve chats",
              explanation: "Keep the conversations.",
            },
            {
              hunkId: "test/archive.test.ts#0",
              path: "test/archive.test.ts",
              title: "Check behavior",
              explanation: "Assert the archive behavior.",
            },
          ],
          skipped: [],
          complete: true,
        },
      };
    else if (
      path === "/api/environments/environment-1" &&
      request.method() === "PATCH"
    ) {
      body = { error: "Could not save project. Try again." };
      status = 503;
    }
    await route.fulfill({ json: body, status });
  });
}

// Wait for hydration before clicking server-rendered controls.
async function openFixture(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByTestId("fixture-ready")).toHaveAttribute("data-ready", "true", { timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await stubApis(page);
  // Each test starts with clean state; every view still uses the real stores.
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
});

const VIEW_PATHS: Record<string, string> = {
  project: "/projects/project-1",
  settings: "/settings/org",
  automations: "/automations",
  review: "/review",
  detail: "/review/neevai-labs/outrunner/337",
};

for (const view of [
  "home",
  "project",
  "settings",
  "automations",
  "review",
  "detail",
]) {
  test(`${view} fits the viewport and has a readable primary heading`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openFixture(page, `${VIEW_PATHS[view] ?? "/"}?view=${view}`);
    await expect(page.locator("h1")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page
      .getByRole("status", { name: "Sessions loaded" })
      .waitFor({ state: "visible", timeout: 2000 })
      .catch(() => {});
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      ),
    ).toBe("rgb(6, 5, 5)");
    await mkdir(".context/ui-redesign", { recursive: true });
    await page.screenshot({
      path: `.context/ui-redesign/${view}-${info.project.name}.png`,
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
}

test("inbox filters locally and preserves unknown and partial counts", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/review")) requests.push(request.url());
  });
  await openFixture(page, "/review?view=review");
  const inbox = page.getByRole("region", { name: "Pull requests" });
  await expect(inbox.getByRole("listitem")).toHaveCount(3);
  await expect(inbox.getByTitle("Line counts unavailable")).toHaveCount(1);
  await expect(inbox.getByText("≥", { exact: true })).toBeVisible();
  await page
    .getByLabel("Repository", { exact: true })
    .selectOption("neevai-labs/neev-ai");
  await expect(inbox.getByRole("listitem")).toHaveCount(1);
  await page.getByLabel("Search pull requests").fill("nothing matches");
  await expect(
    inbox.getByText("No pull requests match your filters."),
  ).toBeVisible();
  expect(requests).toEqual([]);
});

test("chat keeps its draft and conversation through Info/Chat switches", async ({
  page,
}) => {
  await openFixture(page, "/review/neevai-labs/outrunner/337?view=detail");
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  const draft = page.getByPlaceholder("Ask about this PR");
  await draft.fill("How does restore work?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(
    page.getByText("Archive preserves every conversation in the snapshot."),
  ).toBeVisible();
  await draft.fill("Keep this draft");
  await page.getByRole("tab", { name: "Info", exact: true }).click();
  await expect(draft).toBeHidden();
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  await expect(draft).toHaveValue("Keep this draft");
  await expect(
    page.getByText("Archive preserves every conversation in the snapshot."),
  ).toBeVisible();
});

test("Files mounts on first use, retains selections, and a quote opens and focuses Chat", async ({
  page,
}) => {
  await openFixture(page, "/review/neevai-labs/outrunner/337?view=detail");
  await expect(page.locator("[data-file]")).toHaveCount(0);
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page
    .getByText("export const preserveChats = true;", { exact: true })
    .click();
  await page.getByRole("tab", { name: "Description", exact: true }).click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Drop the picked lines" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Chat", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByPlaceholder("Ask about this PR")).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Drop the quoted lines" }),
  ).toBeVisible();
});

test("keyboard tab navigation works without exposing hidden controls", async ({
  page,
}) => {
  await openFixture(page, "/review/neevai-labs/outrunner/337?view=detail");
  const description = page.getByRole("tab", {
    name: "Description",
    exact: true,
  });
  await description.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Files", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(description).toBeFocused();
  await expect(page.getByPlaceholder("Ask about this PR")).toBeHidden();
});

test("hidden Chat pauses progress polling and refreshes when reopened", async ({
  page,
}) => {
  let polls = 0;
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      request.url().includes("/api/review/change?")
    )
      polls++;
  });
  await page.clock.install();
  await openFixture(page, "/review/neevai-labs/outrunner/337?view=detail");
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  await page.getByPlaceholder("Ask about this PR").fill("Preserve the draft");
  await page.getByRole("button", { name: "Ask for a change" }).click();
  await expect(
    page.getByText("Making the change…", { exact: true }),
  ).toBeVisible();
  expect(polls).toBeGreaterThanOrEqual(1);
  await page.getByRole("tab", { name: "Info", exact: true }).click();
  const stoppedAt = polls;
  await page.clock.fastForward(12_000);
  expect(polls).toBe(stoppedAt);
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  await expect.poll(() => polls).toBeGreaterThan(stoppedAt);
});

test("hidden Files pauses tour shortcuts and keeps the current step", async ({
  page,
}) => {
  await openFixture(page, "/review/neevai-labs/outrunner/337?view=detail");
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "Start tour", exact: true }).click();
  await page.getByRole("button", { name: "Begin", exact: true }).click();
  await expect(page.getByText("Step 1 of 2")).toBeVisible();
  await page.getByRole("tab", { name: "Description", exact: true }).click();
  await page.locator("body").press("ArrowRight");
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(page.getByText("Step 1 of 2")).toBeVisible();
});

test("failed project saves keep edits; read-only projects disable fields", async ({
  page,
}) => {
  await openFixture(page, "/projects/project-1?view=project");
  const name = page.getByLabel("Project name", { exact: true });
  await name.fill("My edited project");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("Could not save project. Try again."),
  ).toBeVisible();
  await expect(name).toHaveValue("My edited project");
  await openFixture(page, "/projects/readonly?view=project&state=readonly");
  await expect(name).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Environment variables", exact: true })
    .click();
  await expect(page.getByText("API_TOKEN", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Variables to add")).toBeDisabled();
});

test("successful project saves update the page heading", async ({ page }) => {
  await page.route("**/api/environments/environment-1", async (route) => {
    await route.fulfill({
      json: { ...environment, ...route.request().postDataJSON() },
    });
  });
  await openFixture(page, "/projects/project-1?view=project");
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Renamed project");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Renamed project",
  );
});

test("merged sidebar icon remains identifiable without checks or a visible number", async ({
  page,
}) => {
  await openFixture(page, "/chips?view=chips");
  const icon = page.getByRole("img", {
    name: /Merged pull request neevai-labs\/outrunner#284/,
  });
  await expect(icon).toBeVisible();
  await expect(icon).toHaveText("");
  await expect(icon).toHaveAttribute("title", /Secondary panes/);
  await expect(page.getByText("#284", { exact: true })).toHaveCount(2);
});

test("working sessions use the boxed thinking animation in the sidebar", async ({ page }) => {
  const at = new Date().toISOString();
  await page.route("**/api/sessions/standings", (route) =>
    route.fulfill({
      json: {
        standings: {
          "preview-0": {
            standing: "working",
            reason: null,
            moved: false,
            pinned: false,
            unread: false,
            replyPreview: null,
            at,
          },
        },
        ids: frame.appData.workspaces.map((workspace) => workspace.id),
      },
    }),
  );
  await openFixture(page, "/");
  if ((page.viewportSize()?.width ?? 1440) < 640) {
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
  }
  // The live standings feed reads on focus after its initial layout value.
  const mark = page.getByRole("img", { name: "Working" });
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    return mark.count();
  }).toBe(1);
  await expect(mark).toBeVisible();
  await expect(mark.locator(".dot-matrix-cell")).toHaveCount(9);
  await expect(mark).not.toHaveClass(/spinner/);
  await mkdir(".context/sidebar-thinking", { recursive: true });
  await page.locator("#app-sidebar").screenshot({ path: ".context/sidebar-thinking/after.png" });
});

test("merged Done sessions use a merge icon while ordinary Done sessions keep the check", async ({ page }) => {
  await openFixture(page, "/?state=merged-sidebar");
  if ((page.viewportSize()?.width ?? 1440) < 640) {
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
  }
  await expect(page.getByRole("img", { name: "Merged pull request" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Done" })).toBeVisible();
});

test("member automation controls are disabled; failed admin changes retain their state", async ({
  page,
}) => {
  await openFixture(page, "/automations?view=automations&state=member");
  await expect(page.getByRole("switch").first()).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "Create automation" }),
  ).toHaveCount(0);
  await page.route("**/api/orgs/*/automations/*", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Could not change automation." },
    }),
  );
  await openFixture(page, "/automations?view=automations");
  const toggle = page.getByRole("switch").first();
  await toggle.click();
  await expect(page.getByText("Could not change automation.")).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
});

test("loading, empty and unavailable states remain distinguishable", async ({
  page,
}) => {
  await openFixture(page, "/review?view=review&state=empty");
  await expect(
    page.getByText("You're all caught up. No open pull requests."),
  ).toBeVisible();
  await openFixture(page, "/review?view=review&state=error");
  await expect(
    page.getByText("Couldn't load pull requests. Please try again."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await openFixture(page, "/automations?view=automations&state=loading");
  await expect(
    page.getByRole("status", { name: "Opening automations" }),
  ).toBeVisible();
  await openFixture(page, "/automations?view=automations&state=error");
  await expect(
    page.getByText(
      "Couldn't load the automations. Reload the page to try again.",
    ),
  ).toBeVisible();
});

test("500-file diff stays folded and does not render until Files opens", async ({
  page,
}) => {
  await openFixture(page, "/review/neevai-labs/outrunner/337?view=detail&state=large");
  await expect(page.locator("[data-file]")).toHaveCount(0);
  const started = Date.now();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(page.locator("[data-file]")).toHaveCount(500);
  await expect(page.locator("[data-hunk]")).toHaveCount(0);
  test.info().annotations.push({
    type: "500-file render",
    description: `${Date.now() - started}ms`,
  });
});

function contrast(a: number[], b: number[]) {
  const luminance = (rgb: number[]) =>
    rgb
      .map((c) => c / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [x, y] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (x + 0.05) / (y + 0.05);
}

test("monochrome controls retain readable contrast, orange accents, and matching menu/modal backgrounds", async ({
  page,
}) => {
  await openFixture(page, "/surfaces?view=surfaces");
  const primary = page.getByRole("button", { name: "Primary action" });
  const colors = await primary.evaluate((button) => {
    const s = getComputedStyle(button);
    // Resolve CSS colors (including OKLCH) to sRGB for contrast assertions.
    const context = document.createElement("canvas").getContext("2d")!;
    const rgb = (color: string) => {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    };
    return { bg: rgb(s.backgroundColor), fg: rgb(s.color) };
  });
  expect(colors.bg[0]).toBeGreaterThan(200);
  expect(new Set(colors.bg).size).toBe(1);
  expect(new Set(colors.fg).size).toBe(1);
  expect(contrast(colors.bg, colors.fg)).toBeGreaterThanOrEqual(4.5);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-brand").trim())).toBe("#ff8800");
  await primary.focus();
  await expect(primary).toBeFocused();
  expect(
    await primary.evaluate((button) => getComputedStyle(button).boxShadow),
  ).not.toBe("none");
  await page.getByRole("button", { name: "Open dropdown" }).click();
  expect(
    await page
      .getByRole("menu")
      .evaluate((menu) => getComputedStyle(menu).backgroundColor),
  ).toBe("rgb(6, 5, 5)");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open modal" }).click();
  expect(
    await page
      .getByRole("dialog")
      .evaluate((modal) => getComputedStyle(modal).backgroundColor),
  ).toBe("rgb(6, 5, 5)");
});

test("long names and branches fit narrow content panels", async ({ page }) => {
  await page.setViewportSize({ width: 704, height: 800 });
  for (const view of ["project", "review", "detail"]) {
    await openFixture(page, `${VIEW_PATHS[view]}?view=${view}&state=long`);
    await expect(page.locator("h1")).toBeVisible();
    const bounds = await page
      .getByRole("main")
      .evaluate((main) => ({
        width: main.clientWidth,
        scroll: main.scrollWidth,
      }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width);
  }
});

/** Count the session's lifecycle calls, answering each as `answer` says. */
async function watchLifecycle(page: Page, answer: (attempt: number) => { status?: number; json: unknown } = () => ({ json: {} })) {
  const calls: unknown[] = [];
  await page.route("**/api/workspaces/preview-0/lifecycle", async (route) => {
    calls.push(route.request().postDataJSON());
    await route.fulfill(answer(calls.length));
  });
  return calls;
}

async function openSidebar(page: Page, project: string) {
  if (project === "mobile") await page.getByRole("button", { name: "Open menu", exact: true }).click();
}

test("a sidebar row archives in one click, and Undo takes it back before anything is sent", async ({ page }, testInfo) => {
  const calls = await watchLifecycle(page);
  await openFixture(page, "/");
  await openSidebar(page, testInfo.project.name);
  const archive = page.getByRole("button", { name: "Archive Improve workspace navigation", exact: true });
  // Delete is gone from a session with work to keep: Archive took its place.
  await page.getByRole("button", { name: "More for Improve workspace navigation", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Delete", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  if (testInfo.project.name === "desktop") {
    await page.getByRole("link", { name: "Improve workspace navigation" }).first().hover();
    await page.screenshot({ path: ".context/sidebar-archive-hover.png" });
  }
  await archive.click();
  await expect(archive).toHaveCount(0);
  const toast = page.getByText("Archived “Improve workspace navigation”", { exact: true });
  await expect(toast).toBeVisible();
  if (testInfo.project.name === "desktop") await page.screenshot({ path: ".context/sidebar-archive-undo.png" });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(toast).toHaveCount(0);
  await expect(archive).toHaveCount(1);
  expect(calls).toEqual([]);
});

test("an archive not undone is sent once Undo has passed, and the session stays out of the sidebar", async ({ page }, testInfo) => {
  const calls = await watchLifecycle(page, () => ({ json: { workspace: { id: "preview-0", status: "archived" } } }));
  await openFixture(page, "/");
  await openSidebar(page, testInfo.project.name);
  const sent = page.waitForRequest((request) => request.url().endsWith("/api/workspaces/preview-0/lifecycle"), { timeout: 10_000 });
  await page.getByRole("button", { name: "Archive Improve workspace navigation", exact: true }).click();
  expect((await sent).postDataJSON()).toEqual({ action: "archive" });
  await expect.poll(() => calls).toEqual([{ action: "archive" }]);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "More for Improve workspace navigation", exact: true })).toHaveCount(0);
});

test("an archived session isn't listed in the sidebar", async ({ page }, testInfo) => {
  await openFixture(page, "/?state=archived");
  await openSidebar(page, testInfo.project.name);
  await expect(page.getByRole("button", { name: "More for Improve workspace navigation", exact: true })).toHaveCount(0);
});

test("the header's Archive leaves the session, and a refusal says why", async ({ page }, testInfo) => {
  await page.route("**/api/workspaces/preview-0/chats", (route) => route.fulfill({ json: { chats: [] } }));
  const calls = await watchLifecycle(page, () => ({ status: 409, json: { error: "This workspace is busy. Please try again." } }));
  await openFixture(page, "/workspaces/preview-0");
  if (testInfo.project.name === "desktop") {
    await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  }
  await expect(page.getByRole("button", { name: "Delete session", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Archive session", exact: true }).click();
  // Left at once: open, its page would restore it the moment it read archived.
  await expect(page).toHaveURL(/\/$/);
  // Dismissing the toast sends it now.
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  const notice = page.getByRole("alert").filter({ hasText: "Couldn't archive “Improve workspace navigation”" });
  await expect(notice).toContainText("This workspace is busy. Please try again.");
  await expect.poll(() => calls).toEqual([{ action: "archive" }]);
});
