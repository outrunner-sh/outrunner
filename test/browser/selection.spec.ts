import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { selectionMenu } from "./selection-fixtures";
import { stubSelectionApis as fixture } from "./selection-api-fixture";
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ0kAAAAASUVORK5CYII=", "base64");
async function open(page: Page, path = "/new") {
  await page.goto(path);
  await expect(page.getByTestId("fixture-ready")).toHaveAttribute("data-ready", "true");
  await expect(page.getByRole("button", { name: /^Harness: Codex/ })).toBeVisible();
}
async function menu(page: Page, row: "Harness" | "Model" | "Effort") {
  await page.getByRole("button", { name: /^Harness:/ }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^${row} `) }).click();
}
test("new composer preserves draft and attachment across harnesses and sends exact runtime selections", async ({ page }, info) => {
  const state = await fixture(page); await open(page);
  await page.getByRole("textbox", { name: "Message Codex" }).fill("Preserve my draft and image");
  await page.locator('input[type="file"]').setInputFiles({ name: "image.png", mimeType: "image/png", buffer: image });
  await expect(page.getByText("image.png attached", { exact: true })).toBeAttached();
  await menu(page, "Harness");
  await expect(page.getByRole("menuitemradio", { name: "Codex", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Claude Code", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message Claude Code", exact: true })).toHaveValue("Preserve my draft and image");
  await menu(page, "Model");
  await page.getByRole("menuitemradio", { name: "GLM 5.3 1x", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(page.getByText("can't see images.", { exact: false })).toBeVisible();
  await menu(page, "Harness"); await page.getByRole("menuitemradio", { name: "Codex", exact: true }).click();
  await menu(page, "Effort");
  await expect(page.getByRole("menuitemradio", { name: "Max", exact: true })).toHaveCount(0);
  await page.getByRole("menuitemradio", { name: "Low", exact: true }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.stored().effort).toBe("low");
  await expect(page).toHaveURL(/\/workspaces\//);
  await expect(page.getByRole("button", { name: /^Harness: Codex.*Low effort/ })).toBeVisible();
  await expect.poll(() => state.evidence.some((event) => (event as { stage: string }).stage === "delivered first prompt")).toBe(true);
  expect(state.evidence).toContainEqual(expect.objectContaining({ stage: "delivered first prompt", body: expect.objectContaining({ attachmentIds: ["55555555-5555-4555-8555-555555555555"] }) }));
  await mkdir(".context/selection", { recursive: true });
  await writeFile(`.context/selection/routing-${info.project.name}.json`, JSON.stringify(state.evidence, null, 2));
});
test("existing composer applies only model-supported effort and keeps a draft while switching", async ({ page }) => {
  const state = await fixture(page); await open(page, "/workspaces/preview-0");
  await page.getByRole("textbox", { name: "Message Codex" }).fill("Draft remains");
  await menu(page, "Model"); await page.getByRole("menuitem", { name: "All models…", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Account text model", exact: true }).click();
  await expect.poll(() => state.stored().model.id).toBe("account-text");
  await expect(page.getByRole("textbox", { name: "Message Codex" })).toHaveValue("Draft remains");
  await menu(page, "Effort");
  await expect(page.getByRole("menuitemradio", { name: "Medium", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitemradio", { name: "High", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("existing harness action forks through the supported API and moves the draft and image", async ({ page }) => {
  const state = await fixture(page); await open(page, "/workspaces/preview-0");
  await page.getByRole("textbox", { name: "Message Codex" }).fill("Continue this draft");
  await page.locator('input[type="file"]').setInputFiles({ name: "image.png", mimeType: "image/png", buffer: image });
  await expect(page.getByText("image.png attached", { exact: true })).toBeAttached();
  await menu(page, "Harness"); await page.getByRole("menuitemradio", { name: "Fork with Claude Code", exact: true }).click();
  await expect(page).toHaveURL(/chat=66666666/);
  await expect(page.getByRole("textbox", { name: "Message Claude Code", exact: true })).toHaveValue("Continue this draft");
  await expect(page.getByText("image.png attached", { exact: true })).toBeAttached();
  expect(state.evidence).toContainEqual(expect.objectContaining({ stage: "fork request", body: { from: "main", agent: "claude" } }));
});
test("an unavailable runtime fork leaves conversation and draft unchanged", async ({ page }) => {
  await fixture(page, true); await open(page, "/workspaces/preview-0");
  await page.getByRole("textbox", { name: "Message Codex" }).fill("Keep this on failure");
  await menu(page, "Harness"); await page.getByRole("menuitemradio", { name: "Fork with Claude Code", exact: true }).click();
  await expect(page.getByText("This computer cannot run that harness.", { exact: false })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Codex" })).toHaveValue("Keep this on failure");
  await expect(page).not.toHaveURL(/chat=/);
});

for (const scope of ["personal", "organization"] as const) {
  test(`${scope} connected catalog offers only its effective account models and exact defaults link`, async ({ page }) => {
    const id = `${scope}-code`;
    const scoped = { ...selectionMenu, codexModels: [{ ...selectionMenu.codexModels![0], id, label: `${scope} coding model` }],
      loadout: { models: [{ provider: "codex" as const, id, effort: "high" as const }], default: { provider: "codex" as const, id } } };
    await fixture(page, false, scoped); await open(page);
    await page.getByRole("button", { name: /^Harness:/ }).click();
    await expect(page.getByRole("menuitem", { name: "Change defaults", exact: true })).toHaveAttribute("href", "/settings/models");
    await page.getByRole("menuitem", { name: new RegExp(`^Model ${scope} coding model`) }).click();
    await expect(page.getByRole("menuitemradio", { name: `${scope} coding model`, exact: true })).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: "Account coding model", exact: true })).toHaveCount(0);
    const bounds = await page.getByRole("menu").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  });
}

test("onboarding's Codex harness choice survives an obsolete suggested model ID", async ({ page }) => {
  const menuWithClaudeDefault = { ...selectionMenu, loadout: { models: [{ provider: "claude" as const, id: "sonnet", effort: "high" as const }], default: { provider: "claude" as const, id: "sonnet" } } };
  await fixture(page, false, menuWithClaudeDefault);
  await open(page, "/new?start=codex");
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByRole("button", { name: /^Harness: Codex.*Account coding model/ })).toBeVisible();
});
