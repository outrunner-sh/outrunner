import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";

import { stubSelectionApis } from "./selection-api-fixture";

// Exercise the real session composer and stream handling. All credentials
// and endpoints here are fixtures; no real project or agent is changed.
test("Claude's secret request opens the form, retries failed delivery and saves without opting in", async ({ page }, info) => {
  await stubSelectionApis(page);
  const frames = [
    { id: "1", data: { t: "state", workspaceId: "preview-0", state: "running" } },
    { id: "2", data: { t: "message", uuid: "request", parentUuid: null, role: "assistant", timestamp: new Date().toISOString(), content: [
      { type: "tool_use", id: "ask-token", name: "mcp__outrunner__request_secrets", input: {
        reason: "Connect the preview to the development API",
        keys: [{ name: "APP_TOKEN", description: "Development API token" }, { name: "APP_REGION", optional: true }],
      } },
    ] } },
  ];
  await page.routeWebSocket("**/fixture-events", (ws) => frames.forEach((frame) => ws.send(JSON.stringify(frame))));
  const answers: unknown[] = [];
  await page.route("**/api/workspaces/*/secrets*", async (route) => {
    answers.push(route.request().postDataJSON());
    if (answers.length === 1) return route.fulfill({ status: 502, json: { error: "Couldn't send them. Please try again." } });
    return route.fulfill({ json: { result: "provided", saved: true } });
  });
  await page.goto("/workspaces/preview-0?harness=claude");
  const card = page.getByRole("group", { name: "Claude Code is asking for secrets" });
  await expect(card).toBeVisible();
  await expect(card.getByText("Saved to this project for future sessions.", { exact: false })).toBeVisible();
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Provide", exact: true })).toBeDisabled();
  await card.locator("#secret-APP_TOKEN").fill("fixture-development-token");
  await expect(card.locator("#secret-APP_TOKEN")).toHaveAttribute("type", "password");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir(".context/secrets", { recursive: true });
  await card.screenshot({ path: `.context/secrets/form-${info.project.name}.png` });
  await card.getByRole("button", { name: "Provide", exact: true }).click();
  await expect(card).toBeVisible();
  await expect(page.getByText("Couldn't send them. Please try again.", { exact: true })).toBeVisible();
  await expect(card.locator("#secret-APP_TOKEN")).toHaveValue("fixture-development-token");
  await card.getByRole("button", { name: "Provide", exact: true }).click();
  await expect(card).toBeHidden();
  expect(answers).toEqual([
    { keys: ["APP_TOKEN", "APP_REGION"], values: { APP_TOKEN: "fixture-development-token" } },
    { keys: ["APP_TOKEN", "APP_REGION"], values: { APP_TOKEN: "fixture-development-token" } },
  ]);
  await expect(page.getByText("fixture-development-token", { exact: true })).toHaveCount(0);
});
