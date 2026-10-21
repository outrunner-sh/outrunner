/**
 * What a shared resource holds: nothing yet ("loading", with the stand-in it
 * was made with), the last answer ("ready"), or the last answer and why the
 * latest look failed ("error").
 */
export type ResourceSnapshot<T> =
  | { status: "loading"; value: T; error: null }
  | { status: "ready"; value: T; error: null }
  | { status: "error"; value: T; error: string };

export type SharedResource<T> = {
  /** The same object until something changes (useSyncExternalStore needs it). */
  getSnapshot: () => ResourceSnapshot<T>;
  /** What a server render (and so hydration) shows: always the stand-in. */
  getServerSnapshot: () => ResourceSnapshot<T>;
  subscribe: (listener: () => void) => () => void;
  /** Look again, whatever is held. Looks at the same time share one. */
  refresh: () => Promise<void>;
  /** The answer: the one held, unless there is none yet or it was
   *  invalidated, when it is looked up. Rejects when that look fails. */
  ensure: () => Promise<T>;
  /** Mark what is held out of date (it changed elsewhere): it still shows,
   *  and the next {@link ensure} looks again. */
  invalidate: () => void;
};

/**
 * One answer kept for the whole page, read by every component that needs it,
 * so a component mounting shows the last answer at once instead of loading it
 * again. Each decides when to look again (`refresh`, `ensure`); a failed look
 * keeps the last answer and says why.
 */
export function sharedResource<T>(load: () => Promise<T>, initial: T): SharedResource<T> {
  const first: ResourceSnapshot<T> = { status: "loading", value: initial, error: null };
  let snapshot: ResourceSnapshot<T> = first;
  let stale = false;
  // Bumped by invalidate: a look started before it answers too early to count.
  let generation = 0;
  let inflight: { promise: Promise<void>; generation: number } | null = null;
  const listeners = new Set<() => void>();

  const set = (next: ResourceSnapshot<T>) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const refresh = () => {
    if (inflight?.generation === generation) return inflight.promise;
    const started = generation;
    const promise = load()
      .then(
        (value) => {
          if (started !== generation) return;
          stale = false;
          set({ status: "ready", value, error: null });
        },
        (error: unknown) => {
          if (started !== generation) return;
          set({ status: "error", value: snapshot.value, error: error instanceof Error ? error.message : String(error) });
        },
      )
      .finally(() => {
        if (inflight?.promise === promise) inflight = null;
      });
    inflight = { promise, generation: started };
    return promise;
  };

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => first,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    ensure: async () => {
      if (snapshot.status !== "ready" || stale) await refresh();
      const answer = snapshot;
      if (answer.status === "error") throw new Error(answer.error);
      return answer.value;
    },
    invalidate: () => {
      stale = true;
      generation += 1;
    },
  };
}
