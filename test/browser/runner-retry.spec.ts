import { expect, test } from "@playwright/test";
import { frame } from "./fixtures";
import { stubSelectionApis } from "./selection-api-fixture";

for (const legacy of [false, true]) test(`retry keeps a Runner's identity and pending work${legacy ? " without a recorded environment" : ""}`, async ({ page }) => {
  test.setTimeout(60_000);
  await stubSelectionApis(page);
  const creations: { path: string; body: unknown }[] = [];
  const deleted: string[] = [];
  let refused = true;
  await page.route("**/api/missions", async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { missions: [] } });
    creations.push({ path: "/api/missions", body: route.request().postDataJSON() });
    if (refused) return route.fulfill({ status: 403, json: { error: "The plan's box limit has been reached." } });
    return route.fulfill({ status: 202, json: { workspace: { id: "runner-replacement" } } });
  });
  await page.route("**/api/projects/*/workspaces", async (route) => {
    creations.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    return route.fulfill({ status: 400, json: { error: "A Runner must use its own endpoint." } });
  });
  await page.route("**/api/workspaces/*/lifecycle", async (route) => {
    deleted.push(new URL(route.request().url()).pathname);
    expect(route.request().postDataJSON()).toEqual({ action: "destroy" });
    return route.fulfill({ json: { workspace: { status: "destroyed" } } });
  });
  // Keep the replacement disconnected so the first prompt and queue remain inspectable.
  await page.route("**/api/workspaces/*/session", (route) => route.fulfill({ status: 503, json: { error: "Fixture is not ready" } }));
  await page.goto(`/workspaces/startup-fixture?view=startup&kind=mission&legacy=${legacy ? 1 : 0}`);
  await expect(page.getByTestId("fixture-ready")).toHaveAttribute("data-ready", "true");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Check authentication first");
  await composer.press("Enter");
  await expect(page.getByRole("region", { name: "Queued messages" }).getByText("Check authentication first")).toBeVisible();
  const queue = await page.evaluate(() => sessionStorage.getItem("outrunner:queue:startup-fixture"));
  await composer.fill("Draft to keep");
  await page.evaluate(() => sessionStorage.setItem("outrunner:first-prompt:startup-fixture", JSON.stringify({
    prompt: "Do a security audit and delegate to Ships", key: "runner-first", attachmentIds: ["audit-context"],
  })));
  await page.getByRole("button", { name: "Fail startup", exact: true }).click();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("The plan's box limit has been reached.")).toBeVisible();
  expect(deleted).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.getItem("outrunner:queue:startup-fixture"))).toBe(queue);
  expect(await page.evaluate(() => sessionStorage.getItem("outrunner:first-prompt:startup-fixture"))).toContain("runner-first");
  refused = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces\/runner-replacement/);
  await expect(page.getByRole("button", { name: /Runner icon:/ })).toBeVisible();
  // On phones the Ships pane starts closed.
  const showShips = page.getByRole("button", { name: "Show Ships", exact: true });
  if (await showShips.isVisible()) await showShips.click();
  await expect(page.getByRole("heading", { name: "Ships", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hide Ships", exact: true }).last().click();
  await expect.poll(() => deleted).toEqual(["/api/workspaces/startup-fixture/lifecycle"]);
  const expected = {
    path: "/api/missions",
    body: {
      branch: "", agent: "claude", provider: "outrunner", model: "moonshotai/kimi-k3", effort: null,
      prompt: "Security audit",
      ...(legacy ? { projectId: frame.appData.workspaces[0].projectId } : { environmentId: "mission-environment" }),
    },
  };
  expect(creations).toEqual([expected, expected]);
  const carried = await page.evaluate(() => ({
    old: sessionStorage.getItem("outrunner:queue:startup-fixture"),
    queue: sessionStorage.getItem("outrunner:queue:runner-replacement"),
    first: JSON.parse(sessionStorage.getItem("outrunner:first-prompt:runner-replacement")!),
  }));
  expect(carried.old).toBeNull();
  expect(carried.queue).toBe(queue);
  expect(carried.first).toEqual({ prompt: "Do a security audit and delegate to Ships", key: "runner-first", attachmentIds: ["audit-context"] });
  await expect(page.getByRole("textbox", { name: /^Message/ })).toHaveValue("Draft to keep");
});
