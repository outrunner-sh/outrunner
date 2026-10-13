import { isDesktopApp } from "@/lib/is-desktop";

/**
 * The Mac app's own update (src-tauri/src/updater.rs): it installs a new
 * version in the background, then this lets the sidebar offer to restart into
 * it. Everything here is null or a no-op outside the Mac app, and in an older
 * one that has no such commands.
 */

type Tauri = {
  core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  event?: {
    listen?: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;
  };
};

function tauri(): Tauri | null {
  if (!isDesktopApp()) return null;
  return (window as unknown as { __TAURI__?: Tauri }).__TAURI__ ?? null;
}

/** The version installed and waiting for a restart, or null. */
export async function waitingUpdate(): Promise<string | null> {
  const invoke = tauri()?.core?.invoke;
  if (!invoke) return null;
  try {
    const version = await invoke("update_status");
    return typeof version === "string" && version ? version : null;
  } catch {
    return null; // an app from before the command
  }
}

/** Call `onReady` with the version once an update finishes installing; returns
 *  how to stop listening. */
export function onUpdateReady(onReady: (version: string) => void): () => void {
  const listen = tauri()?.event?.listen;
  if (!listen) return () => {};
  let stop: (() => void) | null = null;
  let stopped = false;
  listen("update-ready", (event) => {
    if (typeof event.payload === "string" && event.payload) onReady(event.payload);
  }).then(
    (unlisten) => {
      if (stopped) unlisten();
      else stop = unlisten;
    },
    () => {},
  );
  return () => {
    stopped = true;
    stop?.();
  };
}

/** Restart into the installed update. Rejects when there's none waiting. */
export async function restartToUpdate(): Promise<void> {
  const invoke = tauri()?.core?.invoke;
  if (!invoke) throw new Error("Updates come with the Outrunner Mac app.");
  await invoke("restart_to_update");
}
