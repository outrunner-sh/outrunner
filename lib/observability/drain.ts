/**
 * What the server is still doing that a shutdown should wait for: each
 * request under way (server.ts) and each after() body (lib/observability/
 * after.ts). On SIGTERM server.ts stops taking new connections and waits on
 * drained() before it exits.
 *
 * Kept on globalThis, not in this module: server.ts loads it as itself and
 * Next's route bundles load their own copy, and both must count the same.
 * Imports nothing, so server.ts can load it before Next.
 */

type DrainState = { pending: number; draining: boolean; waiters: Set<() => void> };

const KEY = Symbol.for("outrunner.drain");

function state(): DrainState {
  const slot = globalThis as unknown as Record<symbol, DrainState | undefined>;
  return (slot[KEY] ??= { pending: 0, draining: false, waiters: new Set() });
}

/** Counts one piece of work as under way; call what it returns, once or more,
 *  when it's done. */
export function holdOpen(): () => void {
  const s = state();
  s.pending++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    s.pending--;
    if (s.pending === 0) for (const wake of [...s.waiters]) wake();
  };
}

/** How many pieces of work are under way. */
export function pendingWork(): number {
  return state().pending;
}

/** Whether a shutdown has begun: readiness answers 503 from then on. */
export function isDraining(): boolean {
  return state().draining;
}

export function startDraining(): void {
  state().draining = true;
}

/** Resolves true once nothing is under way, or false after `timeoutMs`. */
export function drained(timeoutMs: number): Promise<boolean> {
  const s = state();
  if (s.pending === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      s.waiters.delete(wake);
      resolve(ok);
    };
    const wake = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    s.waiters.add(wake);
  });
}
