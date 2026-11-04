import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/missions") return route.fulfill({ json: { missions: [] } });
    if (path === "/api/notifications") return route.fulfill({ json: { notifications: [], now: new Date().toISOString(), kinds: [] } });
    if (path.includes("standing")) return route.fulfill({ json: { standings: {}, ids: [] } });
    return route.fulfill({ json: {} });
  });
});

test("the repository picker opens inside the screen", async ({ page }) => {
  await page.goto("/new");
  await expect(page.getByTestId("fixture-ready")).toHaveAttribute("data-ready", "true", { timeout: 15_000 });
  await page.getByRole("button", { name: /outrunner/ }).first().click();
  const search = page.getByRole("combobox", { name: "Search repositories" });
  await expect(search).toBeVisible();
  const menu = await search.locator("xpath=ancestor::div[contains(@class,'bg-popover')]").boundingBox();
  const width = page.viewportSize()!.width;
  expect(menu!.x).toBeGreaterThanOrEqual(0);
  expect(menu!.x + menu!.width).toBeLessThanOrEqual(width);
});

test("a dialog keeps a margin and fits the screen", async ({ page }) => {
  await page.goto("/?view=surfaces");
  await expect(page.getByTestId("fixture-ready")).toHaveAttribute("data-ready", "true", { timeout: 15_000 });
  await page.getByRole("button", { name: "Open modal" }).click();
  const dialog = page.getByRole("dialog");
  const viewport = page.viewportSize()!;
  // A 1rem margin each side, once its zoom-in has settled.
  await expect.poll(async () => (await dialog.boundingBox())!.x).toBeGreaterThanOrEqual(16);
  const box = (await dialog.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 16);
  expect(box.height).toBeLessThanOrEqual(viewport.height);
});
