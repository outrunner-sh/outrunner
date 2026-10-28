/**
 * Change the address bar in place, without a navigation: through Next's own
 * history handling, not around it. No state of ours goes in, so Next copies
 * in its own and moves its router to `url` too. A replaceState carrying
 * `window.history.state` (Next's state, marked `__NA` as of next 16.2) is one
 * Next lets through untouched: its router keeps the old URL and writes it back
 * on its next render (a router.refresh, say), undoing the change.
 */
export function replaceAddressBar(url: string): void {
  window.history.replaceState(null, "", url);
}
