import type { Page } from "@playwright/test";
import type { OutrunnerModels } from "@/lib/desktop/local-runtime";
import { frame } from "@/test/browser/fixtures";
import { selectionMenu } from "@/test/browser/selection-fixtures";
import { creationSelection } from "@/lib/runtime/selection";
import { modelGroups, requestedModel, type RecordedModel } from "@/lib/runtime/session-models";
import { startingModel } from "@/lib/runtime/model-switch";
import { chatSelection } from "@/lib/session/chat-selection";
import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import type { AgentId } from "@/lib/agents/registry";

export async function stubSelectionApis(page: Page, failedFork = false, menu: OutrunnerModels = selectionMenu, initialEvents: AgentEvent[] = [], saved?: { agent: AgentId; recorded: RecordedModel }) {
  const groups = modelGroups(menu, ["claude", "codex"]);
  const evidence: unknown[] = [];
  let stored: RecordedModel = saved?.recorded ?? { model: menu.codexModels![0], effort: "high" };
  let storedAgent: AgentId = saved?.agent ?? "codex";
  const history = [...initialEvents];
  let socket: { send: (data: string) => void } | null = null;
  await page.routeWebSocket("**/fixture-events", (ws) => {
    socket = ws;
    ws.send(JSON.stringify({ id: "0", data: { t: "state", workspaceId: "fixture", state: "running" } }));
    history.forEach((data, i) => ws.send(JSON.stringify({ id: String(i + 1), data })));
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const body = request.method() === "POST" && request.headers()["content-type"]?.includes("application/json") ? request.postDataJSON() : null;
    let response: unknown = {};
    if (path === "/api/fixture-selection") response = { agent: storedAgent, model: stored };
    else if (path === "/api/missions") response = { missions: [] };
    else if (path === "/api/notifications") response = { notifications: [], now: new Date().toISOString(), kinds: [] };
    else if (path.includes("standing")) response = { standings: {}, ids: [] };
    else if (path === "/api/outrunner-models") response = menu;
    else if (path === "/api/prompt-history") response = { prompts: [], owner: "fixture" };
    else if (path === "/api/settings/chat") response = { preferences: { steerFollowUps: true } };
    else if (path === "/api/attachments") response = { attachment: { id: "55555555-5555-4555-8555-555555555555", filename: "image.png" } };
    else if (path.endsWith("/message")) { evidence.push({ stage: "delivered first prompt", body }); response = { sentAt: 0 }; }
    else if (path.endsWith("/session")) response = { ptyUrl: "ws://127.0.0.1:3100/fixture-events", eventsUrl: "ws://127.0.0.1:3100/fixture-events" };
    else if (path.endsWith("/chats") && request.method() === "GET") response = { chats: [] };
    else if (path.endsWith("/harness")) {
      evidence.push({ stage: "harness request", body });
      if (failedFork) { await route.fulfill({ status: 409, json: { error: "This computer cannot run that harness." } }); return; }
      const selected = creationSelection(groups, menu.loadout, { model: requestedModel(body) ?? undefined, agent: body.agent, effort: body.effort });
      stored = { model: selected.model, effort: selected.effort };
      storedAgent = selected.agent;
      const boundary: AgentEvent = { t: "message", uuid: `harness-${body.id}`, parentUuid: null, role: "assistant", timestamp: "", content: [], harness: { from: body.expectedAgent, to: body.agent, selection: stored } };
      history.push(boundary);
      socket?.send(JSON.stringify({ id: String(history.length), data: boundary }));
      response = { agent: selected.agent, recorded: stored, operationId: body.id };
    }
    else if ((path.startsWith("/api/projects/") && path.endsWith("/workspaces")) || path.endsWith("/model")) {
      const selected = creationSelection(groups, menu.loadout, { model: requestedModel(body) ?? undefined, agent: body.agent ?? (path.endsWith("/model") ? storedAgent : undefined), effort: body.effort });
      evidence.push({ stage: "client request", path, body });
      stored = await startingModel({ model: selected.model, effort: selected.effort ?? undefined, hasClaude: true, fallback: null, keyFor: async () => "synthetic-fixture-key",
        setModel: async (runtimeRequest) => { evidence.push({ stage: "runtime request", agent: selected.agent, runtimeRequest }); return runtimeRequest; } });
      evidence.push({ stage: "stored selection", agent: selected.agent, model: stored });
      response = path.endsWith("/model") ? { model: stored.model.id, effort: stored.effort } : { workspace: { ...frame.appData.workspaces[0], id: body.id, agent: selected.agent, model: stored, status: "ready" } };
    } else if (path.endsWith("/chats") && request.method() === "POST") {
      if (failedFork) { await route.fulfill({ status: 409, json: { error: "This computer cannot run that harness." } }); return; }
      const model = chatSelection({ agent: "codex", model: stored }, body.agent, groups, menu.loadout);
      evidence.push({ stage: "fork request", body, model });
      response = { chat: { id: "66666666-6666-4666-8666-666666666666", name: "Fork of Main", agent: body.agent, kind: "chat", forkedFrom: body.from, model, createdAt: "2026-10-29T00:00:00Z" } };
    }
    await route.fulfill({ json: response });
  });
  return { evidence, stored: () => stored, emit: (data: AgentEvent) => {
    history.push(data);
    socket?.send(JSON.stringify({ id: String(history.length), data }));
  } };
}
