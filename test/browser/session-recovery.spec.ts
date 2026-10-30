import { expect, test, type Route, type WebSocketRoute } from "@playwright/test";
import { stubSelectionApis } from "./selection-api-fixture";

test.use({ video: { mode: "on", size: { width: 1440, height: 900 } } });

const urls = (id: string) => ({ ptyUrl: "ws://127.0.0.1:3100/pty", eventsUrl: `ws://127.0.0.1:3100/recovery-events?workspace=${id}` });

async function openSession(page: import("@playwright/test").Page, id = "preview-0") {
  await page.goto(`/workspaces/${id}`);
  await expect(page.getByTestId("fixture-ready")).toHaveAttribute("data-ready", "true", { timeout: 15_000 });
}

async function streamReplies(page: import("@playwright/test").Page) {
  const sockets = new Map<string, WebSocketRoute>();
  await page.routeWebSocket("**/recovery-events*", (ws) => {
    const id = new URL(ws.url()).searchParams.get("workspace")!;
    sockets.set(id, ws);
    ws.send(JSON.stringify({ id: "0", data: { t: "state", workspaceId: id, state: "running" } }));
    ws.send(JSON.stringify({ id: "1", data: { t: "message", uuid: `${id}-prompt`, parentUuid: null, role: "user", timestamp: "2026-10-30T10:00:00Z", content: [{ type: "text", text: `Question for ${id}` }] } }));
    ws.send(JSON.stringify({ id: "2", data: { t: "message", uuid: `${id}-reply`, parentUuid: null, role: "assistant", timestamp: "2026-10-30T10:00:01Z", content: [{ type: "text", text: `Reply from ${id}` }] } }));
  });
  return sockets;
}

test("a temporary box restart failure recovers automatically without losing a draft", async ({ page }) => {
  await stubSelectionApis(page);
  await streamReplies(page);
  const requests: string[] = [];
  await page.route("**/api/workspaces/preview-0/session*", async (route) => {
    requests.push(route.request().url());
    if (requests.length === 1) {
      await route.fulfill({ status: 503, json: { error: "Box is waking", code: "box-restore-failed" } });
    } else await route.fulfill({ json: urls("preview-0") });
  });
  await openSession(page);
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  const composer = page.getByRole("textbox", { name: "Message Codex", exact: true });
  await composer.fill("Keep this draft during recovery");
  await expect(page.getByText("Couldn't restart this session's box", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Reply from preview-0", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("Keep this draft during recovery");
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain("fresh=1");
});

test("switching sessions bypasses a stalled warm-up and retains history while reconnecting", async ({ page }, info) => {
  await stubSelectionApis(page);
  const sockets = await streamReplies(page);
  let stalled: Route | null = null;
  let returning: Route | null = null;
  let holdReturn = false;
  await page.route("**/api/workspaces/*/session*", async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split("/")[3];
    if (url.searchParams.has("warm")) {
      if (id === "preview-1") { stalled = route; return; }
      await route.fulfill({ status: 409, json: { error: "No warm-up available" } });
      return;
    }
    if (id === "preview-0" && holdReturn) { returning = route; return; }
    await route.fulfill({ json: urls(id) });
  });
  await openSession(page);
  await expect(page.getByText("Reply from preview-0", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Message Codex", exact: true }).fill("Draft for first session");
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Open menu", exact: true }).click();
  const second = page.locator('aside a[href="/workspaces/preview-1"]');
  await second.hover();
  await expect.poll(() => stalled !== null).toBe(true);
  await second.click();
  await expect(page.getByText("Reply from preview-1", { exact: true })).toBeVisible({ timeout: 5000 });
  await expect(page.getByText("Reply from preview-0", { exact: true })).not.toBeVisible();
  await (stalled as unknown as Route).fulfill({ json: urls("preview-1") });
  await sockets.get("preview-0")!.close();
  holdReturn = true;
  // The URL cache expires too, so returning must ask the server again.
  await page.evaluate(() => { const later = Date.now() + 130_000; Date.now = () => later; });
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page.locator('aside a[href="/workspaces/preview-0"]').click();
  await expect.poll(() => returning !== null).toBe(true);
  await expect(page.getByText("Reply from preview-0", { exact: true })).toBeVisible();
  await expect(page.getByText("Connecting to Codex", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message Codex", exact: true })).toHaveValue("Draft for first session");
  await (returning as unknown as Route).fulfill({ json: urls("preview-0") });
});

test("a persistent restart failure stops retrying and shows a usable retry action", async ({ page }) => {
  await stubSelectionApis(page);
  let requests = 0;
  await page.route("**/api/workspaces/preview-0/session*", async (route) => {
    requests++;
    await route.fulfill({ status: 503, json: { error: "Box is waking", code: "box-restore-failed" } });
  });
  await openSession(page);
  await expect(page.getByText("Couldn't restart this session's box", { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(requests).toBe(3);
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
});
