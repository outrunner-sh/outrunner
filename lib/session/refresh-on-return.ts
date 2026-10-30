/** Recheck a cloud session after a browser has been away long enough for its
 *  connection tokens to expire or its idle computer to pause. A suspended
 *  browser can still report an open socket, so transport loss is not required. */
export const SESSION_RETURN_REFRESH_MS = 5 * 60_000;

type ReturnRefresh = {
  page: EventTarget & { readonly visibilityState: string };
  window: EventTarget;
  now(): number;
  lastValidatedAt(): number;
  attaching(): boolean;
  refresh(): void;
};

/** The attachment owner performs the refresh: it coalesces requests, brings
 *  back a paused computer through /session, and replaces all stream URLs. */
export function refreshSessionOnReturn(deps: ReturnRefresh): () => void {
  const revalidate = () => {
    if (deps.page.visibilityState !== "visible" || deps.attaching()) return;
    if (deps.now() - deps.lastValidatedAt() < SESSION_RETURN_REFRESH_MS) return;
    deps.refresh();
  };
  deps.page.addEventListener("visibilitychange", revalidate);
  deps.window.addEventListener("focus", revalidate);
  deps.window.addEventListener("online", revalidate);
  return () => {
    deps.page.removeEventListener("visibilitychange", revalidate);
    deps.window.removeEventListener("focus", revalidate);
    deps.window.removeEventListener("online", revalidate);
  };
}
