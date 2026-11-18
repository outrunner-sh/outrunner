import { expect, test } from "@playwright/test";
import { stubSelectionApis } from "./selection-api-fixture";

test("a reply's link to a file on the box downloads it, and says why when it can't", async ({ page }) => {
  await stubSelectionApis(page, false, undefined, [{
    t: "message", uuid: "files", parentUuid: null, role: "assistant", timestamp: new Date().toISOString(),
    content: [{ type: "text", text: "Copied the PNG: [outrunner-slack-icon.png](/home/runtime/Downloads/outrunner-slack-icon.png). The zip is [icons.zip](~/Downloads/icons.zip)." }],
  }]);
  await page.route("**/api/workspaces/*/changes", (route) => route.fulfill({ json: { files: [] } }));
  await page.route("**/api/workspaces/*/download?**", (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    return path === "/home/runtime/Downloads/outrunner-slack-icon.png"
      ? route.fulfill({ contentType: "application/octet-stream", body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })
      : route.fulfill({ status: 404, json: { error: "There's no ~/Downloads/icons.zip on the box." } });
  });
  await page.goto("/workspaces/preview-0");
  await expect(page.getByTestId("fixture-ready")).toHaveAttribute("data-ready", "true", { timeout: 20000 });

  const icon = page.getByRole("link", { name: "outrunner-slack-icon.png", exact: true });
  await expect(icon).toHaveAttribute("href", "/api/workspaces/preview-0/download?path=%2Fhome%2Fruntime%2FDownloads%2Foutrunner-slack-icon.png");
  const download = page.waitForEvent("download");
  await icon.click();
  expect((await download).suggestedFilename()).toBe("outrunner-slack-icon.png");

  await page.getByRole("link", { name: "icons.zip", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "There's no ~/Downloads/icons.zip on the box." })).toBeVisible();
  // Neither click left the session for a page the app doesn't have.
  await expect(page).toHaveURL(/\/workspaces\/preview-0$/);
});
