/**
 * VS Code in the browser, on a real Daytona box, through the shipping code:
 * provision a box with this build's agent, make a session, open its editor
 * (the first open installs code-server, so it says "starting" until it's up),
 * open it again, then load the editor's signed link and one of its assets.
 * Another session's id is refused. The box is deleted at the end.
 *
 *   ./scripts/build-agent.sh
 *   RUNTIME_AGENT_BINARY_PATH=.context/build/runtime-agent-linux-amd64 \
 *     node --experimental-strip-types --import ./scripts/test-loader.mjs \
 *          --env-file=.env.local scripts/verify-editor.ts
 */

import { randomBytes } from "node:crypto";
import { Daytona } from "@daytonaio/sdk";

import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { DaytonaRuntimeProvider } from "@/lib/runtime/daytona-provider";

const identity: WorkspaceIdentity = { workspaceId: "verify-editor", projectId: "p", computerId: "c", userId: "u" };
const provider = new DaytonaRuntimeProvider();
const secret = randomBytes(32).toString("hex");
let sandboxId: string | null = null;
const t0 = performance.now();
const at = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;
try {
  const computer = await provider.provisionComputer({ secret, repoFullName: "octocat/Hello-World", sessionEnv: {} });
  sandboxId = computer.sandboxId;
  const agent = new AgentClient(await provider.agentTarget(sandboxId, secret));
  await agent.createWorkspace({ workspaceId: identity.workspaceId, repoFullName: "octocat/Hello-World", branch: "outrunner/editor-check", baseBranch: "master" }, identity);
  console.log(at(), "session made");
  const opened = performance.now();
  let editor = null;
  for (let i = 0; i < 60 && !editor; i++) {
    try {
      editor = await agent.openEditor(identity);
      if (!editor) console.log(at(), "  starting…");
    } catch (e) {
      console.log(at(), "  open failed:", (e as { status?: number; error?: unknown }).status, JSON.stringify((e as { error?: unknown }).error ?? null).slice(0, 400));
      break;
    }
    if (!editor) await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(at(), `first open took ${((performance.now() - opened) / 1000).toFixed(1)}s:`, JSON.stringify(editor));
  if (editor) {
    const again = performance.now();
    await agent.openEditor(identity);
    console.log(at(), `second open took ${((performance.now() - again) / 1000).toFixed(1)}s`);
    const url = new URL((await provider.browserUrl(sandboxId, editor.port, 8 * 3600))!);
    url.searchParams.set("folder", editor.folder);
    const page = await fetch(url);
    const html = await page.text();
    console.log(at(), "editor page:", page.status, html.includes("workbench") ? "VS Code workbench" : html.slice(0, 120));
    const css = html.match(/href="([^"]+\.css)"/)?.[1];
    if (css) console.log(at(), "an asset:", (await fetch(new URL(css, page.url))).status);
  }
  const other = await agent.openEditor({ ...identity, workspaceId: "someone-else" }).then(() => "allowed", (e: { status?: number }) => `refused ${e.status}`);
  console.log(at(), "another session's id:", other);
  const box = await new Daytona().get(sandboxId);
  console.log(at(), "editor log tail:", ((await box.process.executeCommand("tail -3 ~/.outrunner-editor.log 2>&1")).result ?? "").trim().slice(-400));
} catch (error) {
  console.log(at(), "FAILED:", error);
} finally {
  if (sandboxId) await provider.destroyComputerOrThrow(sandboxId).then(() => console.log(at(), "box deleted"), (e) => console.log("! delete failed", e));
}
