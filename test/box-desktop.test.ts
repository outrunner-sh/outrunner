import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

import type { Sandbox } from "@daytonaio/sdk";

import { DEVTOOLS_PORT, NOVNC_PORT } from "@/lib/runtime/box-ports";
import { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import type { SandboxBackend, SandboxBox } from "@/lib/runtime/sandbox/backend";
import { box, MARK_DESKTOP_IN_USE, OPEN_WEB_BROWSER, WEB_BROWSER_SETUP } from "@/lib/runtime/sandbox/daytona";
import { hasDesktop } from "@/lib/runtime/types";

/** The scripts the desktop runs on the box, by the name a log gives them. */
const SCRIPTS: Record<string, string> = { setup: WEB_BROWSER_SETUP, "in use": MARK_DESKTOP_IN_USE, "open browser": OPEN_WEB_BROWSER };

/** A Daytona sandbox that records its computer-use starts, the scripts run
 *  on it and signed links. */
function desktopSandbox(): { sandbox: Sandbox; log: string[] } {
  const log: string[] = [];
  const sandbox = {
    id: "box-1",
    computerUse: {
      start: async () => {
        log.push("start");
        return { message: "started" };
      },
    },
    process: {
      executeCommand: async (command: string) => {
        const name = Object.keys(SCRIPTS).find((n) => command === `bash -c '${SCRIPTS[n].replace(/'/g, "'\\''")}'`);
        log.push(name ?? command);
        return { exitCode: 0, result: "" };
      },
    },
    getSignedPreviewUrl: async (port: number, ttl: number) => {
      log.push(`signed ${port} ${ttl}`);
      return { url: `https://${port}-tok3n.daytonaproxy01.net`, token: "tok3n", port };
    },
  } as unknown as Sandbox;
  return { sandbox, log };
}

test("a Daytona box's desktop starts through computer use, its Web Browser set up, and is viewed through noVNC's socket alone", async () => {
  const { sandbox, log } = desktopSandbox();
  const desktop = box(sandbox).desktop;
  assert.ok(desktop);
  await desktop.start();
  const url = await desktop.viewerUrl(120);
  assert.deepEqual(log, ["start", "setup", `signed ${NOVNC_PORT} 120`]);
  assert.equal(url, `wss://${NOVNC_PORT}-tok3n.daytonaproxy01.net/websockify`);
});

/** A backend whose one box is `b`. */
function backendOf(b: SandboxBox): SandboxBackend {
  return {
    create: async () => b,
    get: async () => b,
    alive: async () => true,
    delete: async () => {},
  };
}

test("opening a desktop starts it first, then links to it", async () => {
  const { sandbox, log } = desktopSandbox();
  const provider = new ComputerRuntimeProvider("daytona", backendOf(box(sandbox)));
  assert.equal(await provider.openDesktop("box-1", 60), `wss://${NOVNC_PORT}-tok3n.daytonaproxy01.net/websockify`);
  assert.deepEqual(log, ["start", "setup", `signed ${NOVNC_PORT} 60`]);
});

test("a box with no desktop says so, starting nothing", async () => {
  const noDesktop = { id: "box-2" } as unknown as SandboxBox;
  const provider = new ComputerRuntimeProvider("neev", backendOf(noDesktop));
  assert.equal(await provider.openDesktop("box-2", 60), null);
});

test("only Daytona sessions offer a desktop", () => {
  assert.equal(hasDesktop("daytona"), true);
  assert.equal(hasDesktop("user-daytona"), true);
  for (const provider of ["neev", "modal", "user-modal", "local"] as const) assert.equal(hasDesktop(provider), false);
});

test("a desktop start that hangs is given up after 30 seconds, not the SDK's five minutes", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const sandbox = {
      id: "box-1",
      computerUse: { start: () => new Promise(() => {}) },
      process: { executeCommand: async () => ({ exitCode: 0, result: "" }) },
    } as unknown as Sandbox;
    const started = box(sandbox).desktop!.start();
    const outcome = started.then(
      () => "started",
      (error: Error) => error.message,
    );
    let settled: string | undefined;
    void outcome.then((value) => (settled = value));
    mock.timers.tick(29_999);
    await Promise.resolve();
    assert.equal(settled, undefined);
    mock.timers.tick(1);
    assert.equal(await outcome, "Daytona's desktop didn't start in time (30 s)");
  } finally {
    mock.timers.reset();
  }
});

test("a desktop whose Web Browser can't be set up still starts, and says why", async () => {
  const failures = [
    async () => {
      throw new Error("the toolbox is down");
    },
    async () => ({ exitCode: 1, result: "mkdir: Permission denied" }),
  ];
  for (const executeCommand of failures) {
    const warn = mock.method(console, "warn", () => {});
    try {
      const sandbox = { id: "box-1", computerUse: { start: async () => ({}) }, process: { executeCommand } } as unknown as Sandbox;
      await box(sandbox).desktop!.start();
      assert.equal(warn.mock.callCount(), 1);
      assert.match(String(warn.mock.calls[0].arguments[0]), /desktop's web browser on Daytona box box-1/);
    } finally {
      warn.mock.restore();
    }
  }
});

/**
 * WEB_BROWSER_SETUP run in a home of its own, then the desktop's Web Browser
 * opened on a URL, as XFCE's dock does. The `chromium` first on the PATH is a
 * fake that writes down how it was started, and, where `sandbox` is false,
 * refuses to start with its sandbox as Chromium does on a Daytona box.
 */
function openWebBrowser(sandbox: boolean, helpersRc?: string): { home: string; launches: string[]; helpersRc: string } {
  const home = mkdtempSync(join(tmpdir(), "desktop-web-browser-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "chromium"),
    [
      "#!/bin/sh",
      'case " $* " in *" --no-sandbox "*) ;; *) if [ "$FAKE_SANDBOX" = no ]; then echo "No usable sandbox!" >&2; exit 1; fi ;; esac',
      'printf "%s\\n" "$*" >> "$HOME/launches"',
    ].join("\n"),
    { mode: 0o755 },
  );
  if (helpersRc !== undefined) {
    mkdirSync(join(home, ".config", "xfce4"), { recursive: true });
    writeFileSync(join(home, ".config", "xfce4", "helpers.rc"), helpersRc);
  }
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, FAKE_SANDBOX: sandbox ? "yes" : "no" };
  // Twice, as every desktop start writes it: the second changes nothing.
  execFileSync("bash", ["-c", WEB_BROWSER_SETUP], { env });
  execFileSync("bash", ["-c", WEB_BROWSER_SETUP], { env });
  execFileSync(join(home, ".outrunner", "desktop", "web-browser"), ["https://example.com"], { env });
  return {
    home,
    launches: readFileSync(join(home, "launches"), "utf8").trim().split("\n"),
    helpersRc: readFileSync(join(home, ".config", "xfce4", "helpers.rc"), "utf8"),
  };
}

const agentBrowserArgs = (home: string) =>
  `--remote-debugging-port=${DEVTOOLS_PORT} --remote-debugging-address=127.0.0.1 --user-data-dir=${home}/.outrunner/desktop/chromium ` +
  "--no-first-run --no-default-browser-check --password-store=basic --start-maximized https://example.com";

test("the desktop's Web Browser is the agent's Chromium, without its sandbox where the box can't give it one", () => {
  const { home, launches, helpersRc } = openWebBrowser(false);
  try {
    assert.deepEqual(launches, [`--no-sandbox ${agentBrowserArgs(home)}`]);
    assert.equal(helpersRc, "WebBrowser=outrunner-web-browser\n");
    const helper = readFileSync(join(home, ".local", "share", "xfce4", "helpers", "outrunner-web-browser.desktop"), "utf8");
    assert.match(helper, /^Type=X-XFCE-Helper$/m);
    assert.match(helper, /^X-XFCE-Category=WebBrowser$/m);
    assert.ok(helper.includes(`X-XFCE-CommandsWithParameter=${home}/.outrunner/desktop/web-browser "%s"\n`));
    // The profile holds every sign-in: the agent's own user's alone.
    assert.equal(statSync(join(home, ".outrunner", "desktop", "chromium")).mode & 0o777, 0o700);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the desktop's Web Browser keeps Chromium's sandbox where it has one, and the user's other helpers", () => {
  const { home, launches, helpersRc } = openWebBrowser(true, "MailReader=thunderbird\nWebBrowser=debian-sensible-browser\n");
  try {
    assert.deepEqual(launches, [agentBrowserArgs(home)]);
    assert.equal(helpersRc, "MailReader=thunderbird\nWebBrowser=outrunner-web-browser\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the desktop's Web Browser starts Chromium as the agent's desktop tools do (runtime-agent/internal/desktop)", () => {
  const go = readFileSync(new URL("../runtime-agent/internal/desktop/browser.go", import.meta.url), "utf8");
  assert.match(go, new RegExp(`const DevToolsPort = ${DEVTOOLS_PORT}\\n`));
  assert.match(go, /filepath\.Join\(home, "\.outrunner", "desktop", "chromium"\)/);
  assert.ok(WEB_BROWSER_SETUP.includes('profile="$HOME/.outrunner/desktop/chromium"'));
  const browserArgs = go.match(/func BrowserArgs\([\s\S]*?\n}\n/)?.[0];
  assert.ok(browserArgs, "BrowserArgs is in browser.go");
  const flags = [...browserArgs.matchAll(/"(--[^"]+)"/g)].map((m) => m[1]);
  assert.ok(flags.length >= 5, `BrowserArgs' flags: ${flags.join(" ")}`);
  for (const flag of flags) assert.ok(WEB_BROWSER_SETUP.includes(flag), `the Web Browser starts Chromium with ${flag}`);
});

test("the user using the desktop is told to the box, for the agent's tools to wait on", async () => {
  const { sandbox, log } = desktopSandbox();
  const provider = new ComputerRuntimeProvider("daytona", backendOf(box(sandbox)));
  assert.equal(await provider.markDesktopInUse("box-1"), true);
  assert.deepEqual(log, ["in use"]);

  const noDesktop = new ComputerRuntimeProvider("neev", backendOf({ id: "box-2" } as unknown as SandboxBox));
  assert.equal(await noDesktop.markDesktopInUse("box-2"), false);
});

test("marking the desktop in use touches the file the agent's tools wait on (runtime-agent/internal/desktop UserActivePath)", () => {
  const go = readFileSync(new URL("../runtime-agent/internal/desktop/server.go", import.meta.url), "utf8");
  assert.match(go, /filepath\.Join\(home, "\.outrunner", "desktop", "user-active"\)/);

  const home = mkdtempSync(join(tmpdir(), "desktop-in-use-"));
  try {
    const before = Date.now();
    // Twice: a box made before has the folder, one just made doesn't.
    for (let i = 0; i < 2; i++) execFileSync("bash", ["-c", MARK_DESKTOP_IN_USE], { env: { ...process.env, HOME: home } });
    const touched = statSync(join(home, ".outrunner", "desktop", "user-active")).mtimeMs;
    assert.ok(touched >= before - 1000, `touched at ${touched}, asked at ${before}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a failed mark says so, for the route to answer it", async () => {
  const sandbox = {
    id: "box-1",
    process: { executeCommand: async () => ({ exitCode: 1, result: "touch: Read-only file system" }) },
  } as unknown as Sandbox;
  await assert.rejects(box(sandbox).desktop!.markInUse(), /marking the desktop in use: exit 1: touch: Read-only file system/);
});

test("the Desktop tab's Browser button opens the agent's browser on the box", async () => {
  const { sandbox, log } = desktopSandbox();
  const provider = new ComputerRuntimeProvider("daytona", backendOf(box(sandbox)));
  assert.equal(await provider.openDesktopBrowser("box-1"), true);
  assert.deepEqual(log, ["open browser"]);

  const noDesktop = new ComputerRuntimeProvider("neev", backendOf({ id: "box-2" } as unknown as SandboxBox));
  assert.equal(await noDesktop.openDesktopBrowser("box-2"), false);
});

test("the browser is set up again before it opens, and opens on the desktop's display, let go of", () => {
  assert.ok(OPEN_WEB_BROWSER.startsWith(WEB_BROWSER_SETUP));
  const launch = OPEN_WEB_BROWSER.slice(WEB_BROWSER_SETUP.length).trim();
  assert.equal(launch, 'DISPLAY=:0 setsid -f "$HOME/.outrunner/desktop/web-browser" >/dev/null 2>&1 </dev/null');
});
