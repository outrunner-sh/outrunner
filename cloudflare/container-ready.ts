/**
 * Helpers for worker.ts that don't need the Workers runtime, so the app's
 * tests can run them under Node.
 */

/**
 * Whether a response from the Container class may be its own error rather
 * than the app's: those are plain-text 500s, and the app's are pages or JSON.
 * Only these are worth reading to tell (isNotRunningError).
 */
export function mayBeContainerError(response: Response): boolean {
  return response.status === 500 && (response.headers.get("content-type") ?? "").startsWith("text/plain");
}

/**
 * Whether the Container class's error says the container wasn't running when
 * the request was sent to it: "Error proxying request to container: The
 * container is not running, consider calling start()". Such a request never
 * reached the app, so sending it again can't do anything twice.
 */
export function isNotRunningError(body: string): boolean {
  return body.startsWith("Error proxying request to container:") && /container is not running/i.test(body);
}

/**
 * Resolves once `done()` holds, checked every `intervalMs`: true then, or
 * false if it still didn't after `timeoutMs`.
 */
export async function waitFor(done: () => boolean, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return true;
}
