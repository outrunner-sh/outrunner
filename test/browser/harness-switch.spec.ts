import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { stubSelectionApis } from "./selection-api-fixture";
import { selectionMenu } from "./selection-fixtures";
import { CLAUDE_DEFAULT_MODEL } from "@/lib/runtime/session-models";
import type { AgentEvent } from "@/lib/runtime/agent-protocol";

test.use({ video: "on" });

const failedRequest: AgentEvent[] = [
  { t: "message", uuid: "original-request", parentUuid: null, role: "user", timestamp: "2026-10-30T10:00:00Z", content: [{ type: "text", text: "Finish the settings change and verify the result." }] },
  { t: "message", uuid: "quota", parentUuid: "original-request", role: "assistant", model: "<synthetic>", timestamp: "2026-10-30T10:00:05Z", content: [{ type: "text", text: "You've hit your limit · resets tomorrow" }] },
];

for (const mission of [false, true]) {
  for (const change of ["effort", "model"] as const) {
    test(`${mission ? "Mission" : "workspace"} retains a later ${change} selection after handoff and reload`, async ({ page }) => {
      const state = await stubSelectionApis(page, false, selectionMenu, failedRequest, { agent: "claude", recorded: { model: CLAUDE_DEFAULT_MODEL, effort: "high" } });
      await page.goto(`/workspaces/preview-0?selection=saved${mission ? "&kind=mission" : ""}`);
      await page.getByRole("textbox", { name: "Message Claude Code" }).fill("Keep my draft across reload");
      await page.getByRole("button", { name: /^Harness:/ }).click();
      await page.getByRole("menuitem", { name: /^Harness / }).click();
      await page.getByRole("menuitemradio", { name: "Codex", exact: true }).click();
      await page.getByRole("button", { name: "Switch & resume", exact: true }).click();
      await expect(page.getByText("Claude Code → Codex · Context handed over", { exact: true })).toBeVisible();
      expect(state.stored().effort).toBe("high");
      state.emit({ t: "message", uuid: "old-model-reply", parentUuid: null, role: "assistant", model: "account-code", stopReason: "end_turn", timestamp: "", content: [{ type: "text", text: "Finished the handoff task." }] });
      await expect(page.getByText("Finished the handoff task.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: /^Harness:/ }).click();
      await page.getByRole("menuitem", { name: new RegExp(`^${change === "effort" ? "Effort" : "Model"} `) }).click();
      if (change === "model") await page.getByRole("menuitem", { name: "All models…", exact: true }).click();
      await page.getByRole("menuitemradio", { name: change === "effort" ? "Low" : "Account text model", exact: true }).click();
      await expect.poll(() => change === "effort" ? state.stored().effort : state.stored().model.id).toBe(change === "effort" ? "low" : "account-text");
      const expected = change === "effort" ? /^Harness: Codex.*Account coding model.*Low effort/ : /^Harness: Codex.*Account text model/;
      await expect(page.getByRole("button", { name: expected })).toBeVisible();
      await page.reload();
      await expect(page.getByText("Claude Code → Codex · Context handed over", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: expected })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Message Codex" })).toHaveValue("Keep my draft across reload");
      expect(state.evidence.filter((event) => (event as { stage: string }).stage === "harness request")).toHaveLength(1);
    });
  }
  test(`${mission ? "Mission" : "workspace"} resumes a failed request on another harness without a new prompt`, async ({ page }, info) => {
    const state = await stubSelectionApis(page, false, selectionMenu, failedRequest);
    await page.goto(`/workspaces/preview-0?agent=claude${mission ? "&kind=mission" : ""}`);
    await expect(page.getByText("Claude Code reached its usage limit.", { exact: false })).toBeVisible();
    await page.getByRole("textbox", { name: "Message Claude Code" }).fill("Keep this unsent draft for later");
    await page.getByRole("button", { name: /^Harness:/ }).click();
    await page.getByRole("menuitem", { name: /^Harness / }).click();
    await page.getByRole("menuitemradio", { name: "Codex", exact: true }).click();
    await expect(page.getByRole("button", { name: "Switch & resume", exact: true })).toBeVisible();
    await mkdir(".context/harness", { recursive: true });
    await page.screenshot({ path: `.context/harness/${mission ? "mission" : "workspace"}-staged-${info.project.name}.png`, fullPage: true });
    await page.getByRole("button", { name: "Switch & resume", exact: true }).click();
    await expect(page.getByText("Claude Code → Codex · Context handed over", { exact: true })).toBeVisible();
    await expect(page.getByText("reached its usage limit.", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Message Codex" })).toHaveValue("Keep this unsent draft for later");
    await expect(page).not.toHaveURL(/chat=/);
    expect(state.evidence).toContainEqual(expect.objectContaining({ stage: "harness request", body: expect.objectContaining({ expectedAgent: "claude", agent: "codex", content: "", attachmentIds: [], resume: true }) }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.context/harness/${mission ? "mission" : "workspace"}-resumed-${info.project.name}.png`, fullPage: true });
  });
}

test("canceling a staged harness selection sends nothing and retains the draft", async ({ page }) => {
  const state = await stubSelectionApis(page, false, selectionMenu, failedRequest);
  await page.goto("/workspaces/preview-0");
  await page.getByRole("textbox", { name: "Message Codex" }).fill("Keep this draft");
  await page.getByRole("button", { name: /^Harness:/ }).click();
  await page.getByRole("menuitem", { name: /^Harness / }).click();
  await page.getByRole("menuitemradio", { name: "Claude Code", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Harness: Codex/ })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Codex" })).toHaveValue("Keep this draft");
  expect(state.evidence).not.toContainEqual(expect.objectContaining({ stage: "harness request" }));
});

test("an uncertain switch keeps its request identity across reload and retry", async ({ page }) => {
  await stubSelectionApis(page, false, selectionMenu, failedRequest);
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/workspaces/*/harness", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    if (requests.length === 1) {
      await route.fulfill({ status: 409, json: { error: "The switch is still settling. Retry with the same selection.", sourceUnchanged: false } });
    } else {
      await route.fulfill({ json: { agent: "codex", recorded: { model: selectionMenu.codexModels![0], effort: body.effort }, operationId: body.id } });
    }
  });
  await page.goto("/workspaces/preview-0?agent=claude");
  await page.getByRole("textbox", { name: "Message Claude Code" }).fill("Retain my unsent draft");
  await page.getByRole("button", { name: /^Harness:/ }).click();
  await page.getByRole("menuitem", { name: /^Harness / }).click();
  await page.getByRole("menuitemradio", { name: "Codex", exact: true }).click();
  await page.getByRole("button", { name: "Switch & resume", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry switch", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.stringify(localStorage).includes("Retain my unsent draft"))).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "Retry switch", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  await expect(page.getByRole("button", { name: "Retry switch", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message Codex" })).toHaveValue("Retain my unsent draft");
});
