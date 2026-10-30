import type { Page } from "@playwright/test";
import { selectionMenu } from "./selection-fixtures";

export async function desktop(
  page: Page,
  state: "ready" | "missing" | "logged-out" | "unknown" = "ready",
) {
  await page.addInitScript(
    ({ state }) => {
      const w = window as unknown as {
        __RUNTIME_DESKTOP__: boolean;
        __TAURI__: unknown;
        nativeCalls: string[];
        approved: boolean;
        cloud: boolean;
      };
      w.__RUNTIME_DESKTOP__ = true;
      w.nativeCalls = [];
      w.approved = false;
      w.cloud = false;
      let path: string | null =
        state === "missing" ? null : "/Users/ada/.local/bin/codex";
      let loggedIn: boolean | null =
        state === "ready" ? true : state === "unknown" ? null : false;
      let canceled = false;
      w.__TAURI__ = {
        core: {
          Channel: class {},
          async invoke(command: string) {
            w.nativeCalls.push(command);
            if (command === "local_status")
              return {
                deviceId: "mac",
                root: "/Users/ada/.outrunner",
                git: "/usr/bin/git",
                tmux: "/app/tmux",
                agentBundled: true,
                claude: null,
                claudeSetup: null,
                agents: {
                  claude: { path: null, loggedIn: null, method: null },
                  codex: {
                    path,
                    loggedIn,
                    method: loggedIn ? "chatgpt" : null,
                  },
                },
              };
            if (command === "local_agent_setup") {
              path = "/Users/ada/.outrunner/bin/codex";
              return;
            }
            if (command === "local_codex_login") {
              canceled = false;
              await new Promise((r) => setTimeout(r, 150));
              if (canceled) throw "login-cancelled";
              loggedIn = true;
              return;
            }
            if (command === "local_codex_login_cancel") {
              canceled = true;
              return;
            }
            if (
              command === "local_pick_folder" ||
              command === "local_check_folder"
            )
              return {
                path: "/Users/ada/projects/demo",
                name: "demo",
                git: true,
                branch: "main",
              };
            if (command === "local_list_sessions") return [];
            if (command === "local_codex_models")
              return [
                {
                  id: "native-coding",
                  label: "Native coding model",
                  provider: "codex",
                  efforts: ["low", "high"],
                  defaultEffort: "high",
                  supportsImages: true,
                },
              ];
            if (command === "connect_codex_start") return;
            if (command === "connect_codex_cancel") return;
            if (command === "connect_codex_poll") {
              if (w.approved) {
                w.cloud = true;
                return { state: "done" };
              }
              return {
                state: "waiting",
                url: "https://auth.openai.com/codex/device",
                code: "ABCD-EFGHI",
              };
            }
            throw `unexpected native command ${command}`;
          },
        },
      };
    },
    { state },
  );
  const writes: { url: string; body: unknown }[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const cloud = await page.evaluate(
      () => (window as unknown as { cloud: boolean }).cloud,
    );
    let data: unknown = {};
    if (req.method() !== "GET")
      writes.push({
        url: path,
        body: req.postData() ? req.postDataJSON() : null,
      });
    if (path === "/api/settings/claude")
      data = { connected: false, last4: null };
    else if (path === "/api/settings/providers") data = { keys: {} };
    else if (path === "/api/settings/agents")
      data = { choices: { claude: null, codex: null } };
    else if (path === "/api/onboarding/agents")
      data = { methods: { claude: [], codex: cloud ? ["codex-account"] : [] } };
    else if (path === "/api/settings/codex/desktop")
      data = {
        attempt: "22222222-2222-4222-8222-222222222222",
        bearer: "synthetic-scoped-ticket",
      };
    else if (path === "/api/settings/codex")
      data = url.searchParams.has("scopes")
        ? {
            user: "11111111-1111-4111-8111-111111111111",
            orgs: [],
            activeOrg: null,
          }
        : {
            connected: cloud,
            reconnect: false,
            pending: null,
            updatedAt: null,
          };
    else if (path === "/api/onboarding/github") data = { access: null };
    else if (path === "/api/github/repositories")
      data = { repositories: [], connected: [] };
    else if (path === "/api/outrunner-models")
      data = {
        ...selectionMenu,
        agents: {
          claude: { cloud: false, local: "mac-login" },
          codex: { cloud: false, local: "mac-login" },
        },
        localMenu: { outrunner: false, keys: [], codexModels: [] },
      };
    else if (path === "/api/prompt-history")
      data = { prompts: [], owner: "fixture" };
    else if (path === "/api/notifications")
      data = { notifications: [], now: new Date().toISOString(), kinds: [] };
    else if (path === "/api/missions") data = { missions: [] };
    await route.fulfill({ json: data });
  });
  return writes;
}
