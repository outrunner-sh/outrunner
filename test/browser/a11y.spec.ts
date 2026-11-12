import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/missions") return route.fulfill({ json: { missions: [] } });
    if (path === "/api/notifications") return route.fulfill({ json: { notifications: [], now: new Date().toISOString(), kinds: [] } });
    if (path.includes("standing")) return route.fulfill({ json: { standings: {}, ids: [] } });
    return route.fulfill({ status: 503, json: { error: "Unavailable in a11y fixture" } });
  });
});

test("the startup status announces its stage, not every tick of its timer", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?view=startup");
  const status = page.getByRole("status").filter({ hasText: "Starting your session" });
  await expect(status).toBeVisible({ timeout: 15_000 });
  // The timer is still shown…
  await expect(status).toContainText(/\d+:\d{2}/);
  // …but a live region re-reads its text on every change, so it is hidden from screen readers.
  expect(await status.ariaSnapshot()).not.toMatch(/\d+:\d{2}/);
  expect(errors).toEqual([]);
});
