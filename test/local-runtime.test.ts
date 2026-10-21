import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentCli,
  claudeSetupNeeded,
  claudeSetupText,
  CODEX_INSTALL_COMMAND,
  LOCAL_RUNNER_LOG,
  localAgentRequest,
  LocalRuntimeError,
  type LocalStatus,
  LocalSocket,
  localAgentState,
  localSocketUrl,
  logInToCodex,
  messageForLocalError,
  missingTools,
  needsClaudeLogin,
  needsCodexLogin,
  runnerDidNotStartDetail,
  runsOnOutrunnerModel,
  toolsToInstall,
  openSocket,
  parseLocalSocketUrl,
} from "@/lib/desktop/local-runtime";

const target = { workspaceId: "ws-1", projectId: "p-1" };

test("a local socket URL names the stream and the workspace, nothing secret", () => {
  const url = localSocketUrl("pty", target);
  assert.ok(url.startsWith("outrunner-local://pty?"));
  assert.ok(!url.includes("token"));
  assert.deepEqual(parseLocalSocketUrl(url), { kind: "pty", target, lastEventId: null });
});

test("the events cursor the session client appends survives the round trip", () => {
  // subscribeEventsWs appends ?lastEventId= / &lastEventId= to whatever URL it has.
  const url = `${localSocketUrl("events", target)}&lastEventId=4096`;
  assert.equal(parseLocalSocketUrl(url)?.lastEventId, "4096");
});

test("other URLs are not local sockets", () => {
  for (const url of ["wss://8080-x.daytona.net/pty?token=t", "outrunner-local://shell?workspace=a&project=b", "outrunner-local://pty?workspace=a", "nonsense"]) {
    assert.equal(parseLocalSocketUrl(url), null, url);
  }
});

test("missing tools are named in install order", () => {
  const status = { deviceId: "d", root: "/r", agentBundled: true, git: "/usr/bin/git", tmux: null, claude: null };
  assert.deepEqual(missingTools(status), ["tmux", "Claude Code"]);
});

test("an app that sets Claude Code up itself never asks the user to install it", () => {
  const base = { deviceId: "d", root: "/r", agentBundled: true, git: "/g", tmux: null, claude: null };
  // Built before it could: installing it is the user's job, as before.
  assert.deepEqual(toolsToInstall(base), ["tmux", "Claude Code"]);
  assert.equal(claudeSetupNeeded(base), false);
  // Built since: the app sets it up once asked, and not again while it is under
  // way or after it failed (that waits for Try again).
  assert.deepEqual(toolsToInstall({ ...base, claudeSetup: null }), ["tmux"]);
  assert.equal(claudeSetupNeeded({ ...base, claudeSetup: null }), true);
  const installing = { state: "installing" as const, received: 0, total: 0 };
  assert.equal(claudeSetupNeeded({ ...base, claudeSetup: installing }), false);
  assert.equal(claudeSetupNeeded({ ...base, claudeSetup: { state: "failed", message: "x" } }), false);
  // One that runs needs nothing.
  assert.equal(claudeSetupNeeded({ ...base, claude: "/c", claudeSetup: null }), false);
});

test("setting up Claude Code shows how far it has got, or why it failed", () => {
  assert.equal(claudeSetupText(null), "Setting up Claude Code for Outrunner…");
  assert.equal(claudeSetupText({ state: "installing", received: 0, total: 0 }), "Setting up Claude Code for Outrunner…");
  assert.equal(
    claudeSetupText({ state: "installing", received: 37_974_663, total: 75_949_326 }),
    "Setting up Claude Code for Outrunner… 50%",
  );
  assert.equal(
    claudeSetupText({ state: "failed", message: "Claude Code's download didn't match its checksum." }),
    "Claude Code's download didn't match its checksum.",
  );
});

test("a session runs on Outrunner's model only when the Mac clearly isn't logged in and the server has them", () => {
  const status = { deviceId: "d", root: "/r", agentBundled: true, git: "/g", tmux: "/t", claude: "/c" };
  assert.equal(runsOnOutrunnerModel({ ...status, claudeLoggedIn: false }, true), true);
  assert.equal(runsOnOutrunnerModel({ ...status, claudeLoggedIn: false }, false), false);
  assert.equal(runsOnOutrunnerModel({ ...status, claudeLoggedIn: true }, true), false);
  // Can't tell, or no Claude Code at all (that is set up, not routed around).
  assert.equal(runsOnOutrunnerModel({ ...status, claudeLoggedIn: null }, true), false);
  assert.equal(runsOnOutrunnerModel({ ...status, claude: null, claudeLoggedIn: false }, true), false);
});

test("only a clear no from the app asks for a Claude Code login", () => {
  const status = { deviceId: "d", root: "/r", agentBundled: true, git: "/g", tmux: "/t", claude: "/c" };
  assert.equal(needsClaudeLogin({ ...status, claudeLoggedIn: false }), true);
  assert.equal(needsClaudeLogin({ ...status, claudeLoggedIn: true }), false);
  // The app could not tell, or predates the check: leave it to the session.
  assert.equal(needsClaudeLogin({ ...status, claudeLoggedIn: null }), false);
  assert.equal(needsClaudeLogin(status), false);
  // Not installed is a missing tool, not a login.
  assert.equal(needsClaudeLogin({ ...status, claude: null, claudeLoggedIn: false }), false);
});

test("each agent CLI reads as missing, logged out or ready, from any app", () => {
  const base: LocalStatus = { deviceId: "d", root: "/r", agentBundled: true, git: "/g", tmux: "/t", claude: "/c" };
  const cli = (path: string | null, loggedIn: boolean | null) => ({ path, loggedIn, method: null });
  const withAgents = (codex: ReturnType<typeof cli>): LocalStatus => ({
    ...base,
    claudeLoggedIn: true,
    agents: { claude: cli("/c", true), codex },
  });
  assert.equal(localAgentState(withAgents(cli(null, null)), "codex"), "missing");
  assert.equal(localAgentState(withAgents(cli("/x", false)), "codex"), "logged-out");
  assert.equal(localAgentState(withAgents(cli("/x", true)), "codex"), "ready");
  // A login the app can't read is left to the CLI in the session.
  assert.equal(localAgentState(withAgents(cli("/x", null)), "codex"), "ready");
  assert.equal(needsCodexLogin(withAgents(cli("/x", false))), true);
  assert.equal(needsCodexLogin(withAgents(cli("/x", null))), false);
  // Not installed is a missing tool, not a login.
  assert.equal(needsCodexLogin(withAgents(cli(null, false))), false);
  assert.equal(localAgentState(withAgents(cli(null, null)), "claude"), "ready");

  // An app from before `agents`: Claude Code from its own fields, no Codex.
  assert.deepEqual(agentCli({ ...base, claudeLoggedIn: false }, "claude"), cli("/c", false));
  assert.equal(localAgentState({ ...base, claudeLoggedIn: false }, "claude"), "logged-out");
  assert.equal(localAgentState(base, "claude"), "ready");
  assert.equal(localAgentState(base, "codex"), "missing");
  assert.equal(needsCodexLogin(base), false);
});

test("a failed login says what Claude Code said", () => {
  assert.equal(
    messageForLocalError("login-failed: OAuth error | Request failed"),
    "Claude Code couldn't log in. It said: Request failed",
  );
  assert.match(messageForLocalError("login-failed: "), /type \/login/);
  assert.match(messageForLocalError("login-timed-out"), /Try again/);
});

test("Codex's login errors name Codex, and a missing one says how to install it", async () => {
  assert.equal(
    messageForLocalError("login-failed: Starting local login server | Error: port 1455 is in use", "codex"),
    "Codex couldn't log in. It said: Error: port 1455 is in use",
  );
  assert.match(messageForLocalError("login-failed: ", "codex"), /Run `codex login` in Terminal/);
  assert.equal(messageForLocalError("login-cancelled", "codex"), "The Codex login was stopped. Try again.");
  assert.equal(messageForLocalError("login-cancelled"), "The Claude Code login was stopped. Try again.");
  assert.ok(messageForLocalError("codex-missing").includes(`\`${CODEX_INSTALL_COMMAND}\``));
  assert.match(
    messageForLocalError(new Error("local_codex_login not allowed. Command not found"), "codex"),
    /can't log Codex in\. Update the app/,
  );

  // Through the app: the command it runs, and the error worded for Codex.
  const sent: string[] = [];
  (globalThis as Record<string, unknown>).window = {
    __RUNTIME_DESKTOP__: true,
    __TAURI__: {
      core: {
        invoke: (cmd: string) => {
          sent.push(cmd);
          return Promise.reject("login-failed: Error: access denied");
        },
        Channel: class {},
      },
    },
  };
  await assert.rejects(logInToCodex(), { message: "Codex couldn't log in. It said: Error: access denied" });
  assert.deepEqual(sent, ["local_codex_login"]);
});

test("a runner that didn't start says why, what still works, and where its log is", async () => {
  assert.equal(
    messageForLocalError("agent-did-not-start: listen tcp: address already in use"),
    "This Mac's session runner didn't start. It stopped with: listen tcp: address already in use. Cloud sessions still work. Its log is ~/.outrunner/agent.log.",
  );
  // One that never answered has no reason to give.
  assert.equal(
    messageForLocalError("agent-did-not-start"),
    "This Mac's session runner didn't start. Cloud sessions still work. Its log is ~/.outrunner/agent.log.",
  );
  assert.match(messageForLocalError("agent-spawn-failed: Permission denied (os error 13)"), /It stopped with: Permission denied \(os error 13\)\. Cloud/);
  assert.equal(runnerDidNotStartDetail("it exited with code 7"), "It stopped with: it exited with code 7. Cloud sessions still work.");
  assert.equal(runnerDidNotStartDetail("panic: boom!"), "It stopped with: panic: boom! Cloud sessions still work.");
  assert.equal(runnerDidNotStartDetail(null), "Cloud sessions still work.");

  // Through the app, the code and reason stay with the sentence, so the page
  // can show the reason and the log apart.
  (globalThis as Record<string, unknown>).window = {
    __RUNTIME_DESKTOP__: true,
    __TAURI__: {
      core: { invoke: () => Promise.reject("agent-did-not-start: it exited with code 7"), Channel: class {} },
    },
  };
  const error = await localAgentRequest(target, "GET", "/workspaces").catch((e: unknown) => e);
  assert.ok(error instanceof LocalRuntimeError);
  assert.equal(error.code, "agent-did-not-start");
  assert.equal(error.reason, "it exited with code 7");
  assert.equal(LOCAL_RUNNER_LOG, "~/.outrunner/agent.log");
  assert.match(error.message, /^This Mac's session runner didn't start\./);

  // An agent's own message carries no reason to split out.
  (globalThis as Record<string, unknown>).window = {
    __RUNTIME_DESKTOP__: true,
    __TAURI__: { core: { invoke: () => Promise.reject("folder-missing"), Channel: class {} } },
  };
  const missing = await localAgentRequest(target, "GET", "/workspaces").catch((e: unknown) => e);
  assert.ok(missing instanceof LocalRuntimeError);
  assert.equal(missing.code, "folder-missing");
  assert.equal(missing.reason, null);
});

test("a session the agent has no folder for reads as deleted, not 'unknown workspace'", () => {
  assert.match(messageForLocalError("agent: unknown workspace"), /isn't on this Mac any more/);
});

test("app error codes become sentences; agent messages pass through", () => {
  assert.match(messageForLocalError("folder-missing"), /isn.t there any more/);
  assert.match(messageForLocalError("folder-not-chosen"), /Choose the folder/);
  assert.match(messageForLocalError(new Error("agent-did-not-start")), /agent\.log/);
  assert.equal(messageForLocalError("agent: worktree add: branch exists"), "worktree add: branch exists");
});

test("an app too old for the page says to update it, not Tauri's refusal", () => {
  // As Tauri words it for a command missing from the app (tauri 2.11).
  const clone = messageForLocalError(new Error("local_clone_repo not allowed. Command not found"));
  assert.match(clone, /can't clone repositories\. Update the app, or choose a folder/);
  assert.match(messageForLocalError("local_something_new not allowed. Command not found"), /Update the app/);
  // A refusal for another reason stays as it was.
  assert.match(messageForLocalError("local_status not allowed on origin [https://x]"), /not allowed on origin/);
  // An app whose list of agent routes predates the page's call.
  assert.equal(
    messageForLocalError(new Error("route-not-allowed: POST /workspaces/6f1c/auth")),
    "This version of the Outrunner app can't do that yet. Update the app, then try again.",
  );
});

// ---------------------------------------------------------------------------
// LocalSocket over a fake Tauri core, as the app's relay would drive it.
// ---------------------------------------------------------------------------

type Sent = { cmd: string; args?: Record<string, unknown> };

function fakeDesktop() {
  const sent: Sent[] = [];
  let channel: { onmessage: (m: unknown) => void } | null = null;
  let resolveOpen: (id: number) => void = () => {};
  class Channel {
    onmessage: (m: unknown) => void = () => {};
    constructor() {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      channel = this;
    }
  }
  const invoke = (cmd: string, args?: Record<string, unknown>) => {
    sent.push({ cmd, args });
    if (cmd === "local_socket_open") return new Promise<number>((resolve) => (resolveOpen = resolve));
    return Promise.resolve(null);
  };
  (globalThis as Record<string, unknown>).window = {
    __RUNTIME_DESKTOP__: true,
    __TAURI__: { core: { invoke, Channel } },
  };
  (globalThis as Record<string, unknown>).CloseEvent ??= class extends Event {
    code: number;
    reason: string;
    wasClean: boolean;
    constructor(type: string, init: { code: number; reason: string; wasClean: boolean }) {
      super(type);
      this.code = init.code;
      this.reason = init.reason;
      this.wasClean = init.wasClean;
    }
  };
  return {
    sent,
    emit: (event: unknown) => channel?.onmessage(event),
    resolveOpen: (id: number) => resolveOpen(id),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("frames sent before the relay returns its id are queued, not lost", async () => {
  const desktop = fakeDesktop();
  const socket = openSocket(`${localSocketUrl("pty", target)}`) as unknown as LocalSocket;
  assert.ok(socket instanceof LocalSocket);
  const opened = desktop.sent.find((s) => s.cmd === "local_socket_open");
  assert.equal(opened?.args?.kind, "pty");
  assert.equal(opened?.args?.workspaceId, "ws-1");

  // The session client sends its first resize from the open handler, which
  // can fire before invoke("local_socket_open") resolves.
  socket.addEventListener("open", () => socket.send('{"t":"resize","cols":80,"rows":24}'));
  desktop.emit({ type: "open" });
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.equal(desktop.sent.filter((s) => s.cmd === "local_socket_send").length, 0);

  desktop.resolveOpen(7);
  await tick();
  const sends = desktop.sent.filter((s) => s.cmd === "local_socket_send");
  assert.deepEqual(sends.map((s) => s.args), [{ id: 7, data: '{"t":"resize","cols":80,"rows":24}' }]);
});

test("messages and the close arrive as WebSocket events", async () => {
  const desktop = fakeDesktop();
  const socket = new LocalSocket(localSocketUrl("events", target));
  const seen: string[] = [];
  socket.addEventListener("message", (e) => seen.push((e as MessageEvent).data as string));
  socket.addEventListener("close", (e) => seen.push(`close:${(e as CloseEvent).code}`));
  desktop.resolveOpen(3);
  await tick();
  desktop.emit({ type: "open" });
  desktop.emit({ type: "message", data: '{"id":"1"}' });
  desktop.emit({ type: "close", code: 1006, reason: "" });
  // Nothing after the close reaches the caller: not a second close, not a
  // message the channel still had in flight.
  desktop.emit({ type: "close", code: 1000, reason: "" });
  desktop.emit({ type: "message", data: '{"id":"2"}' });
  assert.deepEqual(seen, ['{"id":"1"}', "close:1006"]);
  assert.equal(socket.readyState, WebSocket.CLOSED);
  // Sending after close is dropped, as on a WebSocket.
  socket.send("late");
  assert.equal(desktop.sent.filter((s) => s.cmd === "local_socket_send").length, 0);
});

test("closing before the relay answers still closes the relay", async () => {
  const desktop = fakeDesktop();
  const socket = new LocalSocket(localSocketUrl("pty", target));
  socket.close();
  desktop.resolveOpen(9);
  await tick();
  assert.deepEqual(desktop.sent.at(-1), { cmd: "local_socket_close", args: { id: 9 } });
});
