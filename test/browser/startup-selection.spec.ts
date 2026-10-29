import { expect, test } from "@playwright/test";
import { stubSelectionApis } from "./selection-api-fixture";

for (const shared of [false, true]) test(`Start over retains Codex ${shared ? "shared-model" : "native model and effort"} selection, queued files and the draft`, async ({ page }) => {
  test.setTimeout(60_000);
  await stubSelectionApis(page);
  const uploads = ["queued-image", "draft-image"];
  const deleted: string[] = [];
  let creation: Record<string, unknown> | null = null;
  await page.route("**/api/attachments", (route) => route.fulfill({ json: { attachment: { id: uploads.shift(), filename: "image.png" } } }));
  await page.route("**/api/attachments/*", async (route) => {
    if (route.request().method() === "DELETE") deleted.push(route.request().url());
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/projects/*/workspaces", async (route) => {
    creation = route.request().postDataJSON();
    await route.fulfill({ json: { workspace: { id: "startup-replacement" } } });
  });
  // Keep the replacement disconnected: inspect the handoff before it can send.
  await page.route("**/api/workspaces/*/session", (route) => route.fulfill({ status: 503, json: { error: "Replacement awaits fixture readiness" } }));
  await page.goto(`/workspaces/startup-fixture?view=startup&harness=codex&shared=${shared ? 1 : 0}`);
  await expect(page.getByTestId("fixture-ready")).toHaveAttribute("data-ready", "true");
  await page.evaluate(() => sessionStorage.setItem("outrunner:first-prompt:startup-fixture", JSON.stringify({ prompt: "hi", key: "startup-first", attachmentIds: [] })));
  const label = shared ? "Message" : "Message Codex";
  const composer = page.getByRole("textbox", { name: label, exact: true });
  await expect(page.getByRole("button", { name: shared ? /^Harness: Codex.*Kimi K3/ : /^Harness: Codex.*Account coding model.*High effort/ })).toBeVisible();
  const image = { name: "image.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64") };
  await composer.fill("Queued before failure");
  await page.locator('input[type="file"]').setInputFiles(image);
  await expect(page.getByText("image.png attached", { exact: true })).toBeAttached();
  await composer.press("Enter");
  await expect(page.getByRole("region", { name: "Queued messages" }).getByText("Queued before failure")).toBeVisible();
  const original = await page.evaluate(() => JSON.parse(sessionStorage.getItem("outrunner:queue:startup-fixture")!));
  await composer.fill("Unsent draft with another image");
  await page.locator('input[type="file"]').setInputFiles(image);
  await expect(page.getByText("image.png attached", { exact: true })).toBeAttached();
  await page.getByRole("button", { name: "Fail startup", exact: true }).click();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces\/startup-replacement/);
  expect(creation).toEqual({ branch: "", agent: "codex", provider: shared ? "outrunner" : "codex", model: shared ? "moonshotai/kimi-k3" : "account-code", effort: shared ? null : "high" });
  await expect(page.getByRole("textbox", { name: /^Message/ })).toHaveValue("Unsent draft with another image");
  await expect(page.getByText("image.png attached", { exact: true })).toBeAttached();
  const carried = await page.evaluate(() => ({
    old: sessionStorage.getItem("outrunner:queue:startup-fixture"),
    queue: JSON.parse(sessionStorage.getItem("outrunner:queue:startup-replacement")!),
    first: JSON.parse(sessionStorage.getItem("outrunner:first-prompt:startup-replacement")!),
  }));
  expect(carried.old).toBeNull();
  expect(carried.queue).toEqual(original);
  expect(carried.queue[0].attachmentIds).toEqual(["queued-image"]);
  expect(carried.first).toMatchObject({ prompt: "hi", key: "startup-first" });
  expect(deleted).toEqual([]);
});
