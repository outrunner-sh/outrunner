import { expect, test, type WebSocketRoute } from "@playwright/test";

for (const retry of [false, true]) test(`startup keeps input ordered through reload${retry ? " and a lost acknowledgment" : ""}`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requests: { content: string; queuedKey?: string; firstPromptKey?: string; attachmentIds: string[] }[] = [];
  const frames: object[] = [];
  const sockets = new Set<WebSocketRoute>();
  const accepted = new Set<string>();
  let attachCalls = 0;
  let lostAck = false;
  let releaseFirst!: () => void;
  const firstAck = new Promise<void>((resolve) => { releaseFirst = resolve; });
  await page.routeWebSocket("**/startup-events", (ws) => {
    sockets.add(ws);
    frames.forEach((f) => ws.send(JSON.stringify(f)));
    ws.onClose(() => sockets.delete(ws));
  });
  const emit = (data: object) => {
    const frame = { id: String(frames.length + 1), data };
    frames.push(frame);
    sockets.forEach((ws) => ws.send(JSON.stringify(frame)));
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/settings/chat") return route.fulfill({ json: { preferences: { steerFollowUps: false } } });
    if (path.endsWith("/info")) return route.fulfill({ status: 503, json: { error: "Resource details unavailable in fixture" } });
    if (path === "/api/missions") return route.fulfill({ json: { missions: [] } });
    if (path === "/api/notifications") return route.fulfill({ json: { notifications: [], now: new Date().toISOString(), kinds: [] } });
    if (path.includes("standing")) return route.fulfill({ json: { standings: {}, ids: [] } });
    if (path.endsWith("/session")) {
      attachCalls++;
      return route.fulfill({ json: { ptyUrl: "ws://127.0.0.1:3100/pty", eventsUrl: "ws://127.0.0.1:3100/startup-events" } });
    }
    if (path.endsWith("/message")) {
      const body = route.request().postDataJSON();
      requests.push(body);
      if (body.firstPromptKey) await firstAck;
      const key = body.queuedKey ?? body.firstPromptKey;
      const already = accepted.has(key);
      if (!already) {
        accepted.add(key);
        // The transport fixture only echoes user input, never an assistant reply.
        emit({ t: "message", uuid: key, parentUuid: null, role: "user", timestamp: new Date().toISOString(), content: [{ type: "text", text: body.content }] });
        emit({ t: "state", workspaceId: "startup-fixture", state: "exited" });
      }
      if (retry && body.queuedKey && !lostAck) {
        lostAck = true;
        return route.fulfill({ status: 502, json: { error: "Controlled acknowledgment failure after acceptance" } });
      }
      return route.fulfill({ json: { result: body.firstPromptKey && already ? "already" : "sent" } });
    }
    if (path === "/api/attachments") return route.fulfill({ json: { attachment: { id: "fixture-image", filename: "image.png" } } });
    if (path === "/api/outrunner-models") return route.fulfill({ json: { outrunner: true, allowance: true, available: true, keys: [], loadout: { models: [], default: null }, agents: { claude: { cloud: true, local: false }, codex: { cloud: true, local: false } } } });
    if (path === "/api/prompt-history") return route.fulfill({ json: { prompts: [], owner: "preview-owner" } });
    return route.fulfill({ status: 503, json: { error: "Unavailable in startup fixture" } });
  });
  await page.goto("/?view=startup");
  await expect(page.getByTestId("fixture-ready")).toHaveAttribute("data-ready", "true");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(composer).toBeEnabled();
  await expect(page.getByText("Queued · sends when ready")).toBeVisible();
  expect(attachCalls).toBe(0);
  await composer.fill("Check this image first");
  await page.locator('input[type="file"]').setInputFiles({ name: "image.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64") });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");
  const queue = page.getByRole("region", { name: "Queued messages" });
  await expect(queue.getByText("Check this image first")).toBeVisible();
  await composer.fill("Then explain the smallest fix");
  await composer.press("Enter");
  await expect(queue.locator("li")).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await composer.fill("Unsent draft");
  await page.getByRole("button", { name: "Session info", exact: true }).last().click();
  await expect(page.getByRole("region", { name: "Startup details" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(composer).toHaveValue("Unsent draft");
  await expect(queue.locator("li")).toHaveCount(2);
  expect(requests).toHaveLength(0);
  expect(attachCalls).toBe(0);
  await page.getByRole("button", { name: "Finish fixture startup" }).click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(queue.getByRole("button", { name: "Send now", exact: true }).first()).toBeDisabled();
  await expect(composer).toHaveValue("Unsent draft");
  releaseFirst();
  if (retry) {
    await expect.poll(() => lostAck).toBe(true);
    await expect(page.getByText("Controlled acknowledgment failure after acceptance")).toBeVisible();
    await page.reload();
    await expect(queue.locator("li")).toHaveCount(2);
    await page.getByRole("button", { name: "Finish fixture startup" }).click();
  }
  await expect.poll(() => requests.length).toBe(retry ? 5 : 3);
  expect([...accepted]).toHaveLength(3);
  expect(requests.map((r) => r.content)).toEqual(retry
    ? ["hi", "Check this image first", "hi", "Check this image first", "Then explain the smallest fix"]
    : ["hi", "Check this image first", "Then explain the smallest fix"]);
  expect(requests[1].attachmentIds).toEqual(["fixture-image"]);
  expect(new Set(requests.filter((r) => r.queuedKey).map((r) => r.queuedKey)).size).toBe(2);
  await expect(composer).toHaveValue("Unsent draft");
  await expect(queue).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
