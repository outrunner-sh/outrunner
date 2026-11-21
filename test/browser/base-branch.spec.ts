import { expect, test } from "@playwright/test";
import { stubSelectionApis } from "./selection-api-fixture";

const BRANCHES = ["main", "develop", "release/2.0", "release/2.1"];

test("a new session starts from the branch picked above the composer", async ({ page }) => {
  const state = await stubSelectionApis(page);
  const searched: string[] = [];
  await page.route("**/api/projects/*/branches*", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    searched.push(q);
    await route.fulfill({ json: { branches: BRANCHES.filter((b) => b.includes(q)), complete: true } });
  });
  await page.goto("/new");
  await expect(page.getByTestId("fixture-ready")).toHaveAttribute("data-ready", "true");

  const chip = page.getByRole("button", { name: "main", exact: true });
  await chip.click();
  const search = page.getByRole("combobox", { name: "Search branches" });
  await expect(search).toBeFocused();
  // The default branch first, and marked.
  const options = page.getByRole("listbox", { name: "Branches" }).getByRole("option");
  await expect(options.first()).toContainText("main");
  await expect(options.first()).toContainText("Default");
  await expect(options).toHaveCount(BRANCHES.length);

  await search.fill("release");
  await expect(options).toHaveCount(2);
  expect(searched).toContain("release");
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(page.getByRole("button", { name: "release/2.1", exact: true })).toBeVisible();

  await page.getByRole("textbox", { name: /^Message/ }).fill("Fix the release build");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces\//);
  expect(state.evidence).toContainEqual(expect.objectContaining({ stage: "client request", body: expect.objectContaining({ baseBranch: "release/2.1" }) }));
});

test("a session on the default branch sends no base", async ({ page }) => {
  const state = await stubSelectionApis(page);
  await page.route("**/api/projects/*/branches*", (route) => route.fulfill({ json: { branches: BRANCHES, complete: false } }));
  await page.goto("/new");
  await expect(page.getByTestId("fixture-ready")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "main", exact: true }).click();
  await expect(page.getByText("More branches than these: type to narrow them.")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: /^Message/ }).fill("Fix the build");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces\//);
  const request = state.evidence.find((e) => (e as { stage?: string }).stage === "client request") as { body: Record<string, unknown> };
  expect(request.body).not.toHaveProperty("baseBranch");
});
