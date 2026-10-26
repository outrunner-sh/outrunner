/** Said when the request never reached Outrunner. The browser's own words for
 *  it ("Load failed", "Failed to fetch") name nothing a user can act on. */
export const UNREACHABLE = "Couldn't reach Outrunner. Check your connection.";

/** `fetch`, but a request that never got there fails with {@link UNREACHABLE}
 *  rather than the browser's own words. For callers that read the reply
 *  themselves; requestJson does this too. */
export function reachOutrunner(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init).catch(() => {
    throw new Error(UNREACHABLE);
  });
}

/**
 * A settings call: JSON in, JSON out, and on failure an Error whose message is
 * a sentence for the page. That is the route's own `error` when it gave one,
 * else `fallback`. A reply that isn't JSON (a proxy's error page), or is
 * missing what `has` checks for, counts as a failure that didn't say why.
 */
export async function requestJson<T extends object>(
  url: string,
  {
    method = "GET",
    body,
    has,
    fallback = "Couldn't save that. Outrunner didn't say why.",
  }: { method?: string; body?: unknown; has?: (data: Partial<T>) => boolean; fallback?: string } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(UNREACHABLE);
  }
  const data = (await res.json().catch(() => null)) as (Partial<T> & { error?: unknown }) | null;
  if (!res.ok || data === null || (has && !has(data))) {
    throw new Error(typeof data?.error === "string" && data.error ? data.error : fallback);
  }
  return data as T;
}
