import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LocalSocket,
  localSocketUrl,
  messageForLocalError,
  missingTools,
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

test("app error codes become sentences; agent messages pass through", () => {
  assert.match(messageForLocalError("folder-missing"), /isn.t there any more/);
  assert.match(messageForLocalError("folder-not-chosen"), /Choose the folder/);
  assert.match(messageForLocalError(new Error("agent-did-not-start")), /agent\.log/);
  assert.equal(messageForLocalError("agent: worktree add: branch exists"), "worktree add: branch exists");
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
