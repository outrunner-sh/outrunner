/** Thrown by withTimeout when the work outlasts its limit. */
export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} took longer than ${Math.round(ms / 1000)}s`);
    this.name = "TimeoutError";
  }
}

/**
 * `work`, or a TimeoutError after `ms`: for a call that takes no AbortSignal
 * (an SDK's). The work itself isn't stopped, only no longer waited for.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** A signal that aborts after `ms`, or when `signal` (the caller's own) does. */
export function timeoutSignal(ms: number, signal?: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
