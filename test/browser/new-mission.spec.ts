import { expect, test, type Page } from "@playwright/test";

/** The dialog and its Start Mission button sit wholly inside the window. */
async function expectInView(page: Page) {
  const viewport = page.viewportSize()!;
  const dialog = (await page.getByRole("dialog").boundingBox())!;
  expect(dialog.y).toBeGreaterThanOrEqual(0);
  expect(dialog.y + dialog.height).toBeLessThanOrEqual(viewport.height);
  const start = (await page.getByRole("button", { name: "Start Mission", exact: true }).boundingBox())!;
  expect(start.y + start.height).toBeLessThanOrEqual(viewport.height);
  await expect(page.getByRole("heading", { name: "New Mission" })).toBeInViewport();
  await expect(page.getByRole("textbox", { name: "What it owns, and what to start on" })).toBeInViewport();
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
])
  test(`a Mission starts in an org with 158 projects at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "The sidebar's Missions are a desktop surface here.");
    await page.setViewportSize(viewport);
    const started: unknown[] = [];
    await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
    await page.route("**/api/missions", (route) => {
      if (route.request().method() !== "POST") return route.fulfill({ json: { missions: [] } });
      started.push(route.request().postDataJSON());
      return route.fulfill({ json: { workspace: { id: "mission-1" } } });
    });
    await page.goto("/?state=many-projects");
    await expect(page.getByTestId("fixture-ready")).toHaveAttribute("data-ready", "true", { timeout: 15_000 });
    await page.getByRole("button", { name: "Start a Mission", exact: true }).click();

    // A few chips, the project with the latest session first, though listed last.
    const chips = page.getByRole("radiogroup", { name: "Project" }).getByRole("radio");
    await expect(chips).toHaveCount(5);
    await expect(chips.first()).toHaveAccessibleName("outrunner");
    await expect(chips.first()).toHaveAttribute("aria-checked", "true");
    await expectInView(page);
    const dir = `.context/new-mission/${viewport.width}x${viewport.height}`;
    await page.screenshot({ path: `${dir}-chips.png` });

    // The rest are searched; the list scrolls inside the dialog.
    await page.getByRole("button", { name: "All 158" }).click();
    const search = page.getByRole("combobox", { name: "Search projects" });
    await expect(search).toBeFocused();
    await expect(page.getByRole("listbox", { name: "Projects" }).getByRole("option")).toHaveCount(158);
    await expectInView(page);
    await search.fill("repo-14");
    await expect(page.getByRole("option")).toHaveCount(10);
    await page.screenshot({ path: `${dir}-search.png` });
    // Escape shuts the list, not the dialog.
    await search.press("Escape");
    await expect(search).toBeHidden();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.getByRole("button", { name: "All 158" }).click();
    await search.fill("repo-142");
    await search.press("ArrowDown");
    await search.press("Enter");
    await expect(search).toBeHidden();
    const picked = page.getByRole("radio", { name: "imported-repo-142" });
    await expect(picked).toHaveAttribute("aria-checked", "true");
    await expect(chips).toHaveCount(5);

    await page.getByRole("textbox", { name: "What it owns, and what to start on" }).fill("Own billing");
    await expectInView(page);
    await page.screenshot({ path: `${dir}-ready.png` });
    await page.getByRole("button", { name: "Start Mission", exact: true }).click();
    await expect(page).toHaveURL(/\/workspaces\/mission-1/);
    expect(started).toEqual([{ projectId: "bulk-142", prompt: "Own billing" }]);
  });
