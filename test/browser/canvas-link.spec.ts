import { expect, test } from "@playwright/test";
import { stubSelectionApis } from "./selection-api-fixture";

test.use({ video: { mode: "on", size: { width: 1280, height: 800 } } });

test("Full proposal opens the matching Canvas file without leaving the session", async ({ page }) => {
  await stubSelectionApis(page, false, undefined, [{
    t: "message", uuid: "proposal", parentUuid: null, role: "assistant", timestamp: new Date().toISOString(),
    content: [{ type: "text", text: "The proposal is ready for review.\n\n[Full proposal](/home/runtime/.outrunner/canvas/preview-0/proposal.md)" }],
  }]);
  await page.route("**/api/workspaces/*/changes", (route) => route.fulfill({ json: { files: [] } }));
  await page.route("**/api/workspaces/*/canvas", (route) => route.fulfill({ json: {
    dir: "/home/runtime/.outrunner/canvas/preview-0",
    files: [{ path: "proposal.md", size: 120, modifiedAt: "2026-10-30T08:00:00Z" }],
  } }));
  await page.route("**/api/workspaces/*/canvas/file?**", (route) => route.fulfill({
    contentType: "text/markdown", body: "# Full proposal\n\nKeep sessions organized into Needs you, Working, In review, and Done.\n\nOpen pull requests appear in In review. Done requires a merged pull request.",
  }));
  await page.goto("/workspaces/preview-0");
  await expect(page.getByTestId("fixture-ready")).toHaveAttribute("data-ready", "true", { timeout: 20000 });
  const link = page.getByRole("link", { name: "Full proposal", exact: true });
  await expect(link).toBeVisible({ timeout: 20000 });
  await expect(link).toHaveAttribute("href", "/api/workspaces/preview-0/canvas/file?path=proposal.md");
  await link.click();
  await expect(page.getByRole("tab", { name: "Canvas", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".studio-canvas.is-open")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Full proposal", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/workspaces\/preview-0$/);
});
