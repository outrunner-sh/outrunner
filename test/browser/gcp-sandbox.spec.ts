import { expect, test } from "@playwright/test";

test("GCP setup shows a CLI command and cannot be selected until connected", async ({ page }) => {
  await page.goto("/?view=sandbox");
  await page.getByRole("tab", { name: "Google Cloud" }).click();
  await expect(page.getByText("npx outrunner@latest", { exact: false })).toContainText("sandbox connect gcp");
  await expect(page.getByRole("button", { name: "Use Google Cloud for new sessions" })).toBeDisabled();
  await expect(page.getByText("no JSON key is needed", { exact: false })).toBeVisible();
});
test("connected GCP offers supported sizes and preserves a failed disconnect", async ({ page }) => {
  const settings = { sandbox: "gcp", daytona: { connected: false, hint: null, updatedAt: null }, modal: { connected: false, hint: null, updatedAt: null }, gcp: { connected: true, hint: "sandbox-project", updatedAt: null }, boxSize: "small", boxSizeChosen: true };
  let savedSize: string | undefined;
  await page.route("**/api/settings/sandbox*", async (route) => {
    if (route.request().method() === "DELETE") return route.fulfill({ status: 409, json: { error: "Delete this connection's Google Cloud sessions before disconnecting." } });
    if (route.request().method() === "PUT") { savedSize = route.request().postDataJSON().boxSize; settings.boxSize = savedSize!; }
    await route.fulfill({ json: settings });
  });
  await page.goto("/?view=sandbox&state=connected");
  await expect(page.getByText("sandbox-project", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: /X Small/ })).toHaveCount(0);
  await page.getByRole("radio", { name: /Large/ }).click();
  await expect.poll(() => savedSize).toBe("large");
  await expect(page.getByRole("radio", { name: /Large/ })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Disconnect Google Cloud" }).click();
  await expect(page.getByText("Delete this connection's Google Cloud sessions before disconnecting.", { exact: false })).toBeVisible();
  await expect(page.getByText("sandbox-project", { exact: true })).toBeVisible();
});
