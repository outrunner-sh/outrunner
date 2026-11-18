import { expect, test, type Page } from "@playwright/test";

async function onboardingApis(page: Page) {
  const writes: { path: string; body: unknown }[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") writes.push({ path, body: route.request().postData() ? route.request().postDataJSON() : null });
    const data: Record<string, unknown> = {
      "/api/settings/claude": { connected: false, last4: null },
      "/api/settings/providers": { keys: {} },
      "/api/settings/agents": { choices: { claude: null, codex: null } },
      "/api/onboarding/github": {
        access: { admin: true, accounts: ["outrunner-sh"], available: [], personalGithub: false, appInstallable: true, installNeedsGithub: false, personalConnectable: true },
      },
      "/api/github/repositories": { repositories: [{ githubRepoId: 1, fullName: "outrunner-sh/outrunner", name: "outrunner", owner: "outrunner-sh", private: true, language: "TypeScript", pushedAt: "2026-10-30T00:00:00Z" }], connected: [] },
      "/api/projects/sync": { projects: [{ id: "p1", githubRepoId: 1, fullName: "outrunner-sh/outrunner" }] },
      "/api/environments": { id: "env-1" },
      "/api/onboarding/complete": { ok: true },
    };
    await route.fulfill({ status: 200, json: data[path] ?? {} });
  });
  return writes;
}

async function finishOnboarding(page: Page) {
  await page.goto("/?view=web-onboarding");
  await page.getByRole("button", { name: /OpenAI Codex/ }).click();
  await page.getByRole("button", { name: /Outrunner.s models/ }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect GitHub" })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Pick your repositories" })).toBeVisible();
  await page.getByRole("checkbox", { name: /outrunner-sh\/outrunner/ }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Create environment", exact: true }).click();
  await expect(page.getByRole("heading", { name: "You’re ready to go" })).toBeVisible({ timeout: 15_000 });
}

test("desktop opens the browser once and waits without probing or running local agents", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __RUNTIME_DESKTOP__: boolean; __TAURI__: unknown; commands: string[] };
    w.__RUNTIME_DESKTOP__ = true;
    w.commands = [];
    w.__TAURI__ = { core: { invoke: async (command: string) => {
      w.commands.push(command);
      if (command === "desktop_signin_start") return "attempt-state";
      if (command === "desktop_signin_poll") return { status: "waiting" };
      throw new Error(`Unexpected native action: ${command}`);
    } } };
  });
  await page.goto("/?view=desktop-signin");
  await expect(page.getByRole("heading", { name: "Continue in your browser" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { commands: string[] }).commands.filter((c) => c === "desktop_signin_start").length)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { commands: string[] }).commands.every((c) => ["desktop_signin_start", "desktop_signin_poll"].includes(c)))).toBe(true);
  await expect(page.getByText("Browser sign-in", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Open browser again" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { commands: string[] }).commands.filter((c) => c === "desktop_signin_start").length)).toBe(2);
  // A desktop account that was signed in before this release must also finish
  // any remaining onboarding in the browser, with no local setup screen.
  await page.goto("/?view=web-onboarding");
  await expect(page.getByRole("heading", { name: "Continue in your browser" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose a coding agent" })).toHaveCount(0);

});

test("normal web sign-in never invokes the desktop bridge", async ({ page }) => {
  await page.goto("/?view=desktop-signin");
  await expect(page.getByText("Browser sign-in", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Continue in your browser" })).toHaveCount(0);
});

test("browser setup finishes before the app choice, keeping environment/model and offering a web continuation", async ({ page }) => {
  const writes = await onboardingApis(page);
  let handoffs = 0;
  await page.route("**/auth/desktop/handoff", async (route) => { handoffs++; await route.fulfill({ status: 500, json: {} }); });
  await finishOnboarding(page);
  expect(writes).toContainEqual({ path: "/api/projects/sync", body: { repoIds: [1] } });
  expect(writes.some((w) => w.path === "/api/onboarding/complete")).toBe(true);
  expect(handoffs).toBe(0);
  const href = await page.getByRole("link", { name: "Continue on web" }).getAttribute("href");
  const next = new URL(href!, "http://localhost").searchParams.get("next");
  expect(next).toContain("environment=env-1");
  expect(next).toContain("start=codex-outrunner");
  await expect(page.getByRole("button", { name: "Open desktop app", exact: true })).toBeVisible();
  await expect(page.getByText("On this Mac", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("skipping setup also offers both destinations without opening the app automatically", async ({ page }) => {
  const writes = await onboardingApis(page);
  await page.goto("/?view=web-onboarding");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("heading", { name: "You’re ready to go" })).toBeVisible({ timeout: 15_000 });
  expect(writes.some((w) => w.path === "/api/onboarding/complete")).toBe(true);
  await expect(page.getByRole("link", { name: "Continue on web" })).toHaveAttribute("href", "/auth/desktop/web?next=%2F");
});

test("desktop handoff requires an explicit click and failures leave web continuation available", async ({ page }) => {
  let handoffs = 0;
  await page.route("**/auth/desktop/handoff", async (route) => {
    handoffs++;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ next: "/new?project=p1&start=codex" });
    await route.fulfill({ status: 503, json: { error: "Could not open the desktop app. Please try again." } });
  });
  await page.goto("/?view=desktop-ready");
  expect(handoffs).toBe(0);
  await page.getByRole("button", { name: "Open desktop app", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not open the desktop app" })).toHaveText("Could not open the desktop app. Please try again.");
  expect(handoffs).toBe(1);
  await expect(page.getByRole("link", { name: "Continue on web" })).toBeVisible();
});

test("expired desktop attempts explain how to retry and preserve the web option", async ({ page }) => {
  await page.goto("/?view=desktop-ready&state=expired");
  await expect(page.getByText(/open it and start sign-in again/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Open desktop app", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Continue on web" })).toBeVisible();
});

test("the waiting desktop redeems its own login only when the browser returns, then navigates to the selected project", async ({ page }) => {
  let redeemed: unknown = null;
  await page.addInitScript(() => {
    const w = window as unknown as { __RUNTIME_DESKTOP__: boolean; __TAURI__: unknown; approved: boolean };
    w.__RUNTIME_DESKTOP__ = true;
    w.__TAURI__ = { core: { invoke: async (command: string) => {
      if (command === "desktop_signin_start") return "native-state";
      if (command === "desktop_signin_poll") return w.approved ? { status: "ready", ticket: "opaque-ticket", verifier: "native-verifier" } : { status: "waiting" };
      throw new Error("Unexpected command");
    } } };
  });
  await page.route("**/auth/desktop/redeem", async (route) => {
    redeemed = route.request().postDataJSON();
    await route.fulfill({ status: 200, json: { next: "/signed-in-desktop?project=p1&start=codex" } });
  });
  await page.route("**/signed-in-desktop?*", async (route) => {
    await route.fulfill({ contentType: "text/html", body: "<h1>Desktop session ready</h1>" });
  });
  await page.goto("/?view=desktop-signin");
  await expect(page.getByRole("heading", { name: "Continue in your browser" })).toBeVisible();
  expect(redeemed).toBeNull();
  await page.evaluate(() => { (window as unknown as { approved: boolean }).approved = true; });
  await expect(page.getByRole("heading", { name: "Desktop session ready" })).toBeVisible();
  expect(redeemed).toEqual({ ticket: "opaque-ticket", verifier: "native-verifier", state: "native-state" });
  await expect(page).toHaveURL(/\/signed-in-desktop\?project=p1&start=codex/);
});

test("choosing web leaves in this browser without issuing a desktop grant", async ({ page }) => {
  let handoffs = 0;
  await page.route("**/auth/desktop/handoff", async (route) => { handoffs++; await route.abort(); });
  await page.route("**/auth/desktop/web?*", async (route) => {
    const next = new URL(route.request().url()).searchParams.get("next");
    expect(next).toBe("/new?project=p1&start=codex");
    await route.fulfill({ contentType: "text/html", body: "<h1>Web session ready</h1>" });
  });
  await page.goto("/?view=desktop-ready");
  await page.getByRole("link", { name: "Continue on web" }).click();
  await expect(page.getByRole("heading", { name: "Web session ready" })).toBeVisible();
  expect(handoffs).toBe(0);
});
