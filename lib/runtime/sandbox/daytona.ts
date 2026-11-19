import { Daytona, DaytonaNotFoundError, type CreateSandboxFromSnapshotParams, type Sandbox } from "@daytonaio/sdk";

import { optionalEnv, requireEnv } from "@/lib/env";
import { DEVTOOLS_PORT, NOVNC_PORT } from "@/lib/runtime/box-ports";
import { type BoxIO, shellQuote } from "@/lib/runtime/daytona/deploy";
import type { GitExec } from "@/lib/runtime/git";
import type { ListedBox } from "@/lib/runtime/orphan-boxes";
import {
  homeOf,
  type AgentEndpoint,
  type BoxResources,
  type SandboxBackend,
  type SandboxBox,
} from "@/lib/runtime/sandbox/backend";

/** Longer than a cold snapshot pull; the spike measured ~4s warm. */
const CREATE_TIMEOUT_SECONDS = 180;
/** Signed WS preview lifetime; refreshed on reconnect (Spike 1 finding). */
const SIGNED_URL_TTL_SECONDS = 300;
/** How long a preview's way to its port lasts: well past the five minutes
 *  the gate uses one for (lib/previews/upstream.ts), so it never expires in
 *  use, and short, since one leaked can't be told from the gate's own. */
const PREVIEW_TARGET_TTL_SECONDS = 15 * 60;
/**
 * How long one command on a box may run. The SDK puts no deadline on a
 * command given none, so a call Daytona never answers held a session's setup
 * on "Starting Claude" for good, the box idle. Generous: a large repository's
 * first clone and Claude Code's install are the longest, a few minutes each.
 * Past it the command is ended and its step fails, naming it.
 */
export const EXEC_TIMEOUT_SECONDS = 10 * 60;
/** The SDK's deadline for its other calls (get, start, uploads), 24 hours
 *  unless set: none of them takes minutes. */
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The desktop's screen size. Daytona's computer use starts its display at the
 * VNC_RESOLUTION in the box's environment, 1024×768 without one, and reads it
 * only from the environment the box was made with: a box made before this
 * keeps 1024×768. Wider is more of a web page per screenshot; no wider than
 * this so a screenshot reaches the model at full size, its pixels the ones
 * the agent clicks.
 */
export const DESKTOP_RESOLUTION = "1280x800";

/**
 * How long starting the desktop may take before it's given up: a cold start
 * takes a second or two, so one that hasn't answered in this is stuck, and
 * the Desktop tab should say so and offer a retry, not wait out the SDK's
 * five minutes.
 */
const DESKTOP_START_TIMEOUT_MS = 30_000;

/**
 * Makes the desktop's Web Browser (the globe in XFCE's dock, and a link the
 * desktop opens) the agent's own Chromium. XFCE's default, Debian's
 * sensible-browser, starts Chromium with its sandbox, which a Daytona box
 * can't give it (no user namespaces, no setuid helper): Chromium quits at
 * once with "No usable sandbox!" and the click opens nothing. The helper XFCE
 * is pointed at instead starts it as the agent's desktop tools do
 * (runtime-agent/internal/desktop/browser.go): on the same profile and
 * DevTools port, so the user and the agent share one browser and its
 * sign-ins, and without its sandbox only once it has said it has none.
 * Written on every start, so a box made before this gets it too; only the
 * WebBrowser line of the user's helpers.rc is touched.
 */
export const WEB_BROWSER_SETUP = `set -e
dir="$HOME/.outrunner/desktop"
mkdir -p "$dir" "$HOME/.local/share/xfce4/helpers" "$HOME/.config/xfce4"
cat > "$dir/web-browser" <<'EOF'
#!/bin/sh
# The desktop's Web Browser: the agent's own Chromium, written by Outrunner.
profile="$HOME/.outrunner/desktop/chromium"
log="$HOME/.outrunner/desktop/web-browser.log"
for b in chromium chromium-browser google-chrome google-chrome-stable; do
  command -v "$b" >/dev/null 2>&1 && break
done
(umask 077; mkdir -p "$profile")
set -- --remote-debugging-port=${DEVTOOLS_PORT} --remote-debugging-address=127.0.0.1 --user-data-dir="$profile" --no-first-run --no-default-browser-check --password-store=basic --start-maximized "$@"
"$b" "$@" >"$log" 2>&1 && exit 0
grep -q "No usable sandbox" "$log" || exit 1
exec "$b" --no-sandbox "$@" >>"$log" 2>&1
EOF
chmod 755 "$dir/web-browser"
cat > "$HOME/.local/share/xfce4/helpers/outrunner-web-browser.desktop" <<EOF
[Desktop Entry]
Version=1.0
Type=X-XFCE-Helper
Name=Chromium
Icon=chromium
X-XFCE-Category=WebBrowser
X-XFCE-Commands=$dir/web-browser
X-XFCE-CommandsWithParameter=$dir/web-browser "%s"
NoDisplay=true
EOF
rc="$HOME/.config/xfce4/helpers.rc"
touch "$rc"
{ grep -v '^WebBrowser=' "$rc" || true; echo "WebBrowser=outrunner-web-browser"; } > "$rc.new"
mv "$rc.new" "$rc"
`;

/** WEB_BROWSER_SETUP on the box. A failure is logged, never the desktop's:
 *  it still opens, its Web Browser only as it was. */
async function setUpWebBrowser(sandbox: Sandbox): Promise<void> {
  try {
    await runOnDesktop(sandbox, WEB_BROWSER_SETUP, "setting up the desktop's web browser", DESKTOP_START_TIMEOUT_MS);
  } catch (error) {
    console.warn(`Could not set up the desktop's web browser on Daytona box ${sandbox.id}`, error);
  }
}

/**
 * Touches the file the agent's desktop tools wait on while the user uses
 * the desktop with their own mouse and keyboard
 * (runtime-agent/internal/desktop UserActivePath).
 */
export const MARK_DESKTOP_IN_USE = `mkdir -p "$HOME/.outrunner/desktop" && touch "$HOME/.outrunner/desktop/user-active"`;

/** How long a quick command for the Desktop tab may take on the box. */
const DESKTOP_ACTION_TIMEOUT_MS = 15_000;

/** `script` run by bash on the box, as its user, given up after `timeoutMs`;
 *  throws when it fails, naming `what`. */
async function runOnDesktop(sandbox: Sandbox, script: string, what: string, timeoutMs = DESKTOP_ACTION_TIMEOUT_MS): Promise<void> {
  const res = await withTimeout(
    sandbox.process.executeCommand(`bash -c ${shellQuote(script)}`, undefined, undefined, timeoutMs / 1000),
    timeoutMs,
    `${what} didn't finish in time`,
  );
  if (res.exitCode) throw new Error(`${what}: exit ${res.exitCode}: ${(res.result ?? "").trim()}`);
}

/** `promise`, or a rejection saying `message` once `ms` have gone by. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${message} (${ms / 1000} s)`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** How long a box alive() fetched is reused by keepAlive rather than
 *  fetched again: one reconcile look's span. Older ones are evicted as
 *  alive() adds more. */
const SEEN_REUSE_MS = 60_000;

/** Monotonic suffix so each detached launch gets its own Daytona session. */
let launchSeq = 0;

/**
 * Daytona sandboxes: the deployment's account (DAYTONA_API_KEY, optional
 * DAYTONA_API_URL / _TARGET), or a user's own, on the key `apiKey` reads (for
 * Settings → Sandbox; their account's default region).
 */
export class DaytonaBackend implements SandboxBackend {
  private client: Promise<Daytona> | null = null;
  /** The box alive() last fetched, for keepAlive to reuse (SEEN_REUSE_MS). */
  private readonly lastSeen = new Map<string, { sandbox: Sandbox; at: number }>();
  private readonly apiKey: (() => Promise<string>) | undefined;

  constructor(options: { apiKey?: () => Promise<string> } = {}) {
    this.apiKey = options.apiKey;
  }

  /** Lazy so constructing the backend (e.g. in a test) needs no credentials. */
  private daytona(): Promise<Daytona> {
    this.client ??= (async () => {
      if (this.apiKey) return new Daytona({ apiKey: await this.apiKey(), requestTimeoutMs: REQUEST_TIMEOUT_MS });
      return new Daytona({
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        apiKey: requireEnv("DAYTONA_API_KEY"),
        apiUrl: optionalEnv("DAYTONA_API_URL"),
        target: optionalEnv("DAYTONA_TARGET"),
      });
    })();
    // A key that couldn't be read is asked for again next time.
    this.client.catch(() => {
      this.client = null;
    });
    return this.client;
  }

  /** Snapshot resources are fixed; never send `resources` on this path. */
  async create(labels: Record<string, string>, size?: BoxResources): Promise<SandboxBox> {
    const daytona = await this.daytona();
    // Only Outrunner's own account: a user's own key's boxes keep their
    // account's archive default, their quota being theirs.
    const platform = !this.apiKey;
    const params = createParams(labels, size, platform);
    let sandbox: Sandbox;
    try {
      sandbox = await daytona.create(params, { timeout: CREATE_TIMEOUT_SECONDS });
    } catch (error) {
      // General snapshots may be absent on a self-hosted/other target. Retry
      // only a missing snapshot, never auth, quotas, timeouts or other errors.
      if (!params.snapshot || !(error instanceof DaytonaNotFoundError) || !/snapshot/i.test(error.message)) throw error;
      console.warn(`Daytona snapshot ${params.snapshot} is unavailable; using the account's default snapshot`);
      sandbox = await daytona.create(createParams(labels, undefined, platform), { timeout: CREATE_TIMEOUT_SECONDS });
    }
    if (size && (sandbox.cpu !== size.cpu || sandbox.memory !== size.memoryGb)) {
      console.warn(
        `Daytona box ${sandbox.id}: requested ${size.cpu} vCPU / ${size.memoryGb} GiB; ` +
        `received ${sandbox.cpu} vCPU / ${sandbox.memory} GiB`,
      );
    }
    return box(sandbox);
  }

  async get(id: string): Promise<SandboxBox> {
    return box(await (await this.daytona()).get(id));
  }

  async alive(id: string): Promise<boolean> {
    try {
      const sandbox = await (await this.daytona()).get(id);
      const state = sandbox.state;
      // Kept for keepAlive, which the reconciler calls just after: one get a
      // box a run, not two. Only what it can use (Outrunner's account, a
      // running box), with stale ones dropped as it goes, so the map stays
      // small however often alive() is asked.
      if (!this.apiKey && (state === "started" || state === "resizing")) {
        const now = Date.now();
        for (const [seenId, seen] of this.lastSeen) if (now - seen.at >= SEEN_REUSE_MS) this.lastSeen.delete(seenId);
        this.lastSeen.set(id, { sandbox, at: now });
      } else this.lastSeen.delete(id);
      // A hot resize preserves processes; the reconciler must not mark the
      // computer lost while Daytona applies its new allocation.
      return state === "started" || state === "resizing";
    } catch (error) {
      if (error instanceof DaytonaNotFoundError) {
        this.lastSeen.delete(id);
        return false;
      }
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    const daytona = await this.daytona();
    await daytona.delete(await daytona.get(id));
  }

  /** The account's boxes carrying `labels`, made and last active before
   *  `quietSince`: for the orphaned-box sweep (lib/runtime/orphan-boxes.deps.ts). */
  async *list(labels: Record<string, string>, quietSince: Date): AsyncIterable<ListedBox> {
    const query = { labels, createdAtBefore: quietSince, lastActivityBefore: quietSince };
    for await (const sandbox of (await this.daytona()).list(query)) {
      yield {
        id: sandbox.id,
        labels: sandbox.labels ?? {},
        state: sandbox.state,
        createdAt: sandbox.createdAt,
        lastActivityAt: sandbox.lastActivityAt,
      };
    }
  }

  async pause(id: string): Promise<void> {
    await (await (await this.daytona()).get(id)).stop();
  }

  /** The stopped box `id`, started again on the disk it kept, with `labels`
   *  on it. Null when it's gone or broken, so a new box is the only way on. */
  async restore(id: string, labels: Record<string, string> = {}): Promise<SandboxBox | null> {
    let sandbox: Sandbox;
    try {
      sandbox = await (await this.daytona()).get(id);
    } catch (error) {
      if (error instanceof DaytonaNotFoundError) return null;
      throw error;
    }
    // Still going down: stopping, or archiving, which Daytona does to a box
    // stopped a week. Its disk is kept, so it's waited out and started, not
    // taken for gone (that started a new box, and the session's files were
    // left on this one).
    const state = await settled(sandbox);
    if (STOPPED_STATES.has(state)) {
      try {
        await sandbox.start(CREATE_TIMEOUT_SECONDS);
      } catch (error) {
        // Stopped again rather than left starting where nothing meters or
        // stops it: its computer is saved stopped, which the reconciler
        // doesn't check.
        await sandbox.stop().catch((stopError: unknown) => console.error(`Could not stop box ${id} again`, stopError));
        throw error;
      }
    } else if (STARTING_STATES.has(state)) await sandbox.waitUntilStarted(CREATE_TIMEOUT_SECONDS);
    else if (state !== "started") {
      // Gone or broken, not stopped: a new box rather than retrying this one.
      console.error(`Daytona box ${id} is ${state}, not stopped; starting a new one`);
      return null;
    }
    await relabel(sandbox, labels);
    // A box made before the backstop gets it as it comes back.
    if (!this.apiKey) await backstop(sandbox);
    return box(sandbox);
  }

  /** The reconciler's heartbeat: resets Daytona's auto-stop timer. Only on
   *  Outrunner's account, whose boxes have one (AUTO_STOP_MINUTES). */
  async keepAlive(id: string): Promise<void> {
    if (this.apiKey) return;
    const seen = this.lastSeen.get(id);
    this.lastSeen.delete(id);
    const sandbox = seen && Date.now() - seen.at < SEEN_REUSE_MS ? seen.sandbox : await (await this.daytona()).get(id);
    await sandbox.refreshActivity();
  }
}

/** Put Daytona's auto-stop backstop (AUTO_STOP_MINUTES) on a box of
 *  Outrunner's made before it. Best effort: the box is up either way, and the
 *  reconciler still looks after it. Exported for tests. */
export async function backstop(sandbox: Sandbox): Promise<void> {
  if (sandbox.autoStopInterval === AUTO_STOP_MINUTES) return;
  await Promise.resolve()
    .then(() => sandbox.setAutostopInterval(AUTO_STOP_MINUTES))
    .catch((error: unknown) => console.warn(`Could not set Daytona box ${sandbox.id}'s auto-stop`, error));
}

/** Put `labels` on a box made before them (the deployment's, which the
 *  orphaned-box sweep goes by), keeping its others. Best effort: the box is
 *  up either way. Exported for tests. */
export async function relabel(sandbox: Sandbox, labels: Record<string, string>): Promise<void> {
  const current = sandbox.labels ?? {};
  if (Object.entries(labels).every(([key, value]) => current[key] === value)) return;
  await sandbox
    .setLabels({ ...current, ...labels })
    .catch((error: unknown) => console.warn(`Could not label Daytona box ${sandbox.id}`, error));
}

/**
 * General container snapshots, largest first, checked against
 * https://www.daytona.io/docs/snapshots/ (2026-10-29). These are snapshot
 * sizes, not an account resource ceiling. Custom targets may omit them.
 */
const DAYTONA_SNAPSHOTS = [
  { name: "daytona-large", cpu: 4, memoryGb: 8 },
  { name: "daytona-medium", cpu: 2, memoryGb: 4 },
] as const;

/** The largest named snapshot within BOTH requested resources. Below them,
 * use the account's default as before; warn on any actual size mismatch.
 * Never round CPU up: Outrunner bills by the box's actual vCPUs. */
export function daytonaSnapshotFor(size: BoxResources): string | undefined {
  return DAYTONA_SNAPSHOTS.find((s) => s.cpu <= size.cpu && s.memoryGb <= size.memoryGb)?.name;
}

/**
 * Minutes a box stays stopped before Daytona archives it. A stopped
 * container box holds its full disk against the account's storage quota
 * until archived (https://www.daytona.io/docs/en/limits), and Daytona's
 * default is 7 days: a week of paused sessions filled the account's whole
 * quota and every new box was refused. Archived, the disk is in object
 * storage and the box starts again from it (restore() takes "archived" as
 * stopped), only slower; a day keeps an overnight resume quick. Set only
 * on Outrunner's account: a user's own Daytona keeps its account's default.
 */
export const AUTO_ARCHIVE_MINUTES = 24 * 60;

/**
 * Minutes without an event before Daytona stops one of Outrunner's boxes on
 * its own: the provider-side backstop should Outrunner stop looking after
 * its boxes (the reconciler's cron down, a deploy that broke it), so no box
 * bills for ever. Daytona counts SDK calls and state changes as events, not
 * preview traffic (the agent's API, the browser's socket), so a session in
 * use doesn't keep its box up by itself: the reconciler calls keepAlive on
 * every box it looks at and keeps running (lib/billing/reconcile.ts), every
 * couple of minutes. A long turn on a box the reconciler is watching is never
 * stopped by this; one on a box nothing watches is stopped within 4 hours.
 * Generous on purpose: well past any cron outage worth riding out, and the
 * reconciler's own limits (3h unreachable, 6h stuck in a turn, 12h a run)
 * are what normally stop a box. A user's own Daytona keeps it off: their
 * account, their bill, and nothing of Outrunner's heartbeats it.
 */
export const AUTO_STOP_MINUTES = 4 * 60;

/** Without a size keep the account's default (including user-owned Daytona).
 * Outrunner's selected default size already arrives via boxSizeOn. */
export function createParams(
  labels: Record<string, string>,
  size?: BoxResources,
  /** Outrunner's own account (DAYTONA_API_KEY), whose quota every tenant shares. */
  platform = false,
): CreateSandboxFromSnapshotParams {
  const snapshot = size && daytonaSnapshotFor(size);
  return {
    // Outrunner owns idle stopping (the reconciler); Daytona's auto-stop is
    // only the backstop on Outrunner's own account (AUTO_STOP_MINUTES), and
    // it never deletes a box.
    autoStopInterval: platform ? AUTO_STOP_MINUTES : 0,
    autoDeleteInterval: -1,
    ...(platform && { autoArchiveInterval: AUTO_ARCHIVE_MINUTES }),
    labels,
    envVars: { VNC_RESOLUTION: DESKTOP_RESOLUTION },
    ...(snapshot && { snapshot }),
  };
}

/** States a box is started again from, ones it's on its way up in, and
 *  ones it's on its way down in, keeping its disk. */
const STOPPED_STATES = new Set(["stopped", "archived"]);
const STARTING_STATES = new Set(["starting", "restoring", "creating"]);
const SETTLING_STATES = new Set(["stopping", "archiving"]);
/** How often a box going down is looked at again. */
const SETTLE_POLL_MS = 2_000;
/** Leave room in the 60s lifecycle/attach routes to return a retryable error. */
export const SETTLE_TIMEOUT_SECONDS = 30;

/**
 * The box's state once it's no longer on its way down (SETTLING_STATES),
 * looked at again every `pollMs`. Throws when it still is after
 * `timeoutSeconds`: the box is there, so trying again later is the way on,
 * never a new box. Exported for tests.
 */
export async function settled(
  sandbox: Pick<Sandbox, "id" | "state" | "refreshData">,
  timeoutSeconds = SETTLE_TIMEOUT_SECONDS,
  pollMs = SETTLE_POLL_MS,
): Promise<string> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (SETTLING_STATES.has(sandbox.state ?? "unknown")) {
    if (Date.now() >= deadline) throw new Error(`Daytona box ${sandbox.id} is still ${sandbox.state}`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    await sandbox.refreshData();
  }
  return sandbox.state ?? "unknown";
}

/** A box's commands and files, from its sandbox. Exported for tests. */
export function box(sandbox: Sandbox): SandboxBox {
  const io: BoxIO = {
    exec: async (command) => {
      const res = await sandbox.process.executeCommand(command, undefined, undefined, EXEC_TIMEOUT_SECONDS);
      return { stdout: res.result ?? "", exitCode: res.exitCode ?? 0 };
    },
    // Through a background session with runAsync: a synchronous
    // executeCommand never returns while the daemon it started keeps running
    // (the provisioning spike's `agent_boot` hang). A UNIQUE session per
    // launch: the jcode path launches two daemons, and reusing one session id
    // makes the second collide with the still-running first and silently not
    // execute.
    launch: async (command) => {
      launchSeq += 1;
      const sessionId = `runtime-launch-${sandbox.id}-${launchSeq}`;
      await sandbox.process.createSession(sessionId).catch(() => {});
      await sandbox.process.executeSessionCommand(sessionId, { command, runAsync: true });
    },
    upload: (data, remotePath) => sandbox.fs.uploadFile(data, remotePath),
  };
  // Argv is shell-quoted and wrapped in `bash -lc`; the credential token rides
  // in the process env (never in argv), exactly as on the local/modal paths.
  const gitExec: GitExec = async (argv, options) => {
    const inner = argv.map(shellQuote).join(" ");
    const res = await sandbox.process.executeCommand(
      `bash -lc ${shellQuote(inner)}`,
      undefined,
      options?.env,
      EXEC_TIMEOUT_SECONDS,
    );
    return { stdout: res.result ?? "", stderr: "", exitCode: res.exitCode ?? 0 };
  };
  return {
    id: sandbox.id,
    cpu: sandbox.cpu,
    memoryGb: sandbox.memory,
    growMemory: async (memoryGb) => {
      if (sandbox.state !== "started") throw new Error("Only a running sandbox can grow memory");
      if (!Number.isFinite(memoryGb) || memoryGb <= sandbox.memory) {
        throw new Error("Memory scaling must increase the allocation");
      }
      await sandbox.resize({ memory: memoryGb }, 60);
    },
    io,
    gitExec,
    // Default images aren't /home/runtime; the agent + mirror hang off $HOME.
    home: () => homeOf(io, "/home/daytona"),
    // Both preview flavors: standard for control calls (token as a header),
    // signed for the browser WS (token already in the host).
    agentEndpoint: async (port): Promise<AgentEndpoint> => {
      const [preview, signed] = await Promise.all([
        sandbox.getPreviewLink(port),
        sandbox.getSignedPreviewUrl(port, SIGNED_URL_TTL_SECONDS),
      ]);
      return {
        controlBaseUrl: preview.url,
        controlHeaders: { "x-daytona-preview-token": preview.token },
        wsBaseUrl: signed.url,
      };
    },
    // The token is in the host, so every page, asset and socket under it is
    // let through: what the editor needs.
    browserUrl: async (port, ttlSeconds) => (await sandbox.getSignedPreviewUrl(port, ttlSeconds)).url,
    desktop: {
      // Starts what isn't running (the display, its window manager, the VNC
      // server and noVNC) and leaves what is: a second start is a no-op. Its
      // Web Browser is set up alongside, before anyone can click it.
      start: async () => {
        await Promise.all([
          withTimeout(sandbox.computerUse.start(), DESKTOP_START_TIMEOUT_MS, "Daytona's desktop didn't start in time"),
          setUpWebBrowser(sandbox),
        ]);
      },
      // A signed preview link is good for its one port alone (checked on a
      // real box: the token in it is refused on any other), and noVNC's
      // proxy there forwards to the VNC server alone, a target fixed at its
      // launch that no client can change. So the link reaches the desktop,
      // and not the agent or Daytona's toolbox.
      viewerUrl: async (ttlSeconds) => {
        const url = new URL((await sandbox.getSignedPreviewUrl(NOVNC_PORT, ttlSeconds)).url);
        url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
        url.pathname = "/websockify";
        return url.toString();
      },
      markInUse: () => runOnDesktop(sandbox, MARK_DESKTOP_IN_USE, "marking the desktop in use"),
    },
    // The signed link, its credential good for this one port, and for a
    // quarter of an hour: the standard link's token is the sandbox's, good
    // for every port, the agent's among them, and a header the box's
    // server might be sent and show. The signed link is the Host the box's
    // server may be sent, and so may echo in a page it builds from it,
    // which is why it lasts minutes and is expired as soon as the preview
    // is deleted or made sign-in only (lib/previews/upstream.ts). Daytona's
    // proxy routes by the host, and would show browsers its own warning
    // page before the user's server without the skip header.
    previewTarget: async (port) => {
      const signed = await sandbox.getSignedPreviewUrl(port, PREVIEW_TARGET_TTL_SECONDS);
      return {
        baseUrl: signed.url,
        headers: { "x-daytona-skip-preview-warning": "true" },
        hostHeader: "upstream",
        revoke: () => sandbox.expireSignedPreviewUrl(port, signed.token),
      };
    },
  };
}

/** How long a key check waits on Daytona: a page of sandboxes, at most. */
const KEY_CHECK_TIMEOUT_MS = 15_000;

/** Whether Daytona accepts `apiKey` (Settings → Sandbox checks one before
 *  saving it): false when it refuses it, a throw when it can't be asked. */
export async function daytonaAcceptsKey(apiKey: string): Promise<boolean> {
  try {
    await withTimeout(new Daytona({ apiKey, requestTimeoutMs: KEY_CHECK_TIMEOUT_MS }).list().next(), KEY_CHECK_TIMEOUT_MS, "Daytona didn't answer a key check");
    return true;
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 401 || status === 403) return false;
    throw error;
  }
}
