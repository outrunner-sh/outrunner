import { expect, test, type WebSocketRoute } from "@playwright/test";
import { stubSelectionApis } from "./selection-api-fixture";

test.use({ video: { mode: "on", size: { width: 1280, height: 720 } } });

test("returning to an apparently connected session wakes it before sending the draft", async ({ page }) => {
  test.setTimeout(60_000);
  await stubSelectionApis(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const sockets = new Set<WebSocketRoute>();
  const frames: object[] = [];
  const prompts: string[] = [];
  const attaches: string[] = [];
  let releaseWake!: () => void;
  const waking = new Promise<void>((resolve) => { releaseWake = resolve; });
  const emit = (data: object) => {
    const frame = { id: String(frames.length + 1), data };
    frames.push(frame);
    sockets.forEach((ws) => ws.send(JSON.stringify(frame)));
  };
  await page.routeWebSocket("**/return-events*", (ws) => {
    sockets.add(ws);
    frames.forEach((frame) => ws.send(JSON.stringify(frame)));
    ws.onClose(() => sockets.delete(ws));
  });
  await page.route("**/api/workspaces/startup-fixture/session*", async (route) => {
    attaches.push(route.request().url());
    if (attaches.length === 2) await waking;
    await route.fulfill({ json: { ptyUrl: "ws://127.0.0.1:3100/pty", eventsUrl: `ws://127.0.0.1:3100/return-events?attach=${attaches.length}` } });
  });
  await page.route("**/api/workspaces/startup-fixture/message", async (route) => {
    const { content } = route.request().postDataJSON();
    prompts.push(content);
    emit({ t: "message", uuid: `prompt-${prompts.length}`, parentUuid: null, role: "user", timestamp: new Date().toISOString(), content: [{ type: "text", text: content }] });
    emit({ t: "message", uuid: `reply-${prompts.length}`, parentUuid: null, role: "assistant", timestamp: new Date().toISOString(), content: [{ type: "text", text: prompts.length === 1 ? "Ready when you return." : "Connected again. Your message arrived once." }] });
    emit({ t: "state", workspaceId: "startup-fixture", state: "running" });
    await route.fulfill({ json: { result: "sent" } });
  });
  await page.goto("/?view=startup&harness=codex");
  await expect(page.getByTestId("fixture-ready")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Finish fixture startup" }).click();
  await expect.poll(() => prompts).toEqual(["hi"]);
  const composer = page.getByRole("textbox", { name: "Message Codex", exact: true });
  await composer.fill("Continue from where we left off");

  // The socket stays open: no transport-loss callback can cause recovery.
  await page.evaluate(() => {
    const afterBeingAway = Date.now() + 16 * 60_000;
    Date.now = () => afterBeingAway;
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => attaches.length).toBe(2);
  expect(attaches[1]).toContain("fresh=1");
  await expect(composer).toHaveValue("Continue from where we left off");
  await composer.press("Enter");
  expect(prompts, "a send during wake-up waits for the attachment").toEqual(["hi"]);

  releaseWake();
  await expect.poll(() => prompts).toEqual(["hi", "Continue from where we left off"]);
  await expect(composer).toHaveValue("");
  await expect(page.locator(".timeline-prompt").filter({ hasText: "Continue from where we left off" })).toHaveCount(1);
  await expect(page.getByText(/Not sent/)).toHaveCount(0);
  await expect(page.getByText("Connected again. Your message arrived once.", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
