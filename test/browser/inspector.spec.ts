import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";

import { stubSelectionApis } from "./selection-api-fixture";

test.beforeEach(async ({ page }) => {
  await stubSelectionApis(page);
  await page.route("**/api/workspaces/*/changes", (route) => route.fulfill({ json: { files: [] } }));
  await page.route("**/api/workspaces/*/desktop", (route) => route.fulfill({
    status: 503, json: { error: "Desktop is unavailable in this browser fixture." },
  }));
  await page.route("**/api/workspaces/*/canvas", (route) => route.fulfill({ json: {
    dir: "/workspace/canvas",
    files: [{ path: "plan.md", size: 20, modifiedAt: "2026-10-30T08:00:00Z" }],
  } }));
  await page.route("**/api/workspaces/*/canvas/file?**", (route) => route.fulfill({
    contentType: "text/markdown", body: "# Workspace plan\nKeep the sidebar steady.",
  }));
  await page.goto("/workspaces/preview-0");
  await expect(page.getByTestId("fixture-ready")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  if (page.viewportSize()!.width <= 1100) {
    await page.getByTitle("Show environment", { exact: true }).click();
  }
  await expect(page.getByRole("tab", { name: "Environment", exact: true })).toBeVisible();
});

test("all inspector views keep the sidebar and chat widths, including open Canvas files", async ({ page }, info) => {
  const panel = page.locator(".studio-inspector");
  const panelBounds = await panel.boundingBox();
  const chatBounds = await page.locator(".studio-chat").boundingBox();
  const navBounds = await page.locator("#app-sidebar").boundingBox();
  const toolbarBounds = await page.locator(".studio-inspector-toolbar").boundingBox();
  expect(panelBounds!.width).toBeCloseTo(Math.min(400, page.viewportSize()!.width * 0.92), 0);

  for (const label of ["Changes", "Canvas", "Desktop", "Environment"]) {
    const tab = page.getByRole("tab", { name: label, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(tab.locator("svg")).toBeVisible();
    expect(await panel.boundingBox()).toEqual(panelBounds);
    expect(await page.locator(".studio-chat").boundingBox()).toEqual(chatBounds);
    expect(await page.locator("#app-sidebar").boundingBox()).toEqual(navBounds);
    expect(await page.locator(".studio-inspector-toolbar").boundingBox()).toEqual(toolbarBounds);
    if (label === "Canvas") {
      await page.getByRole("button", { name: /plan.md/ }).click();
      await expect(page.locator(".studio-canvas.is-open")).toBeVisible();
      expect(await panel.boundingBox()).toEqual(panelBounds);
      expect(await page.locator(".studio-chat").boundingBox()).toEqual(chatBounds);
    }
    if (label === "Desktop") {
      await expect(page.getByText("Desktop is unavailable in this browser fixture.")).toBeVisible();
      const screen = await page.locator(".studio-desktop-screen").boundingBox();
      expect(screen!.width).toBeGreaterThan(250);
      expect(screen!.height).toBeGreaterThan(300);
      await mkdir(".context/inspector", { recursive: true });
      await page.screenshot({ path: `.context/inspector/desktop-${info.project.name}.png` });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("icon tabs support keyboard navigation and the panel remembers its tab when reopened", async ({ page }) => {
  const environment = page.getByRole("tab", { name: "Environment", exact: true });
  const changes = page.getByRole("tab", { name: "Changes", exact: true });
  const canvas = page.getByRole("tab", { name: "Canvas", exact: true });
  await environment.focus();
  await environment.press("ArrowRight");
  await expect(changes).toBeFocused();
  await expect(changes).toHaveAttribute("aria-selected", "true");
  await changes.press("End");
  await expect(canvas).toBeFocused();
  await canvas.press("ArrowRight");
  await expect(environment).toBeFocused();
  await environment.press("Home");
  await expect(environment).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Desktop", exact: true }).click();
  await page.getByRole("button", { name: "Hide panel", exact: true }).click();
  await expect(page.locator(".studio-inspector")).toBeHidden();
  await page.getByTitle("Show environment", { exact: true }).click();
  await expect(page.getByRole("tab", { name: "Desktop", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("mobile inspector traps focus around the selected tab and restores it on reopen", async ({ page }) => {
  test.skip(page.viewportSize()!.width > 1100, "The inspector is a modal only on narrow screens.");
  const panel = page.getByRole("dialog");
  for (const label of ["Changes", "Desktop", "Canvas"]) {
    const selected = page.getByRole("tab", { name: label, exact: true });
    await selected.click();
    if (label === "Desktop") {
      await expect(panel.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    } else if (label === "Canvas") {
      await expect(panel.getByRole("button", { name: /plan.md/ })).toBeVisible();
    }
    const last = panel.locator("button:visible").last();
    await selected.press("Shift+Tab");
    await expect(last).toBeFocused();
    await last.press("Tab");
    await expect(selected).toBeFocused();
    await selected.press("Tab");
    await expect(panel.getByRole("button", { name: "Hide panel", exact: true })).toBeFocused();
    await panel.getByRole("button", { name: "Hide panel", exact: true }).click();
    await page.getByTitle("Show environment", { exact: true }).click();
    await expect(selected).toBeFocused();
  }
});
