/**
 * A tab opened on a click, before the page it's for is known: the browser
 * lets a tab through only as part of the click, and the link (a box's editor,
 * a dev server's preview) comes back from the server after. It says
 * `message` meanwhile; `go` sends it on, with no handle back on this page.
 */
export type PendingTab = {
  /** Whether the user closed it while it waited: they gave up. */
  closed(): boolean;
  /** Send it to `url`. A tab the browser blocked on the click is opened now,
   *  which it may block too: false then. */
  go(url: string): boolean;
  close(): void;
};

export function openPendingTab(message: string): PendingTab {
  const tab = window.open("about:blank", "_blank");
  if (tab) {
    tab.document.title = message;
    tab.document.body.style.cssText = "font: 14px system-ui, sans-serif; color: #888; padding: 2rem";
    tab.document.body.textContent = message;
  }
  return {
    closed: () => tab !== null && tab.closed,
    go(url) {
      if (!tab) {
        // Not "noopener", which makes window.open answer null even when the
        // tab opened: the handle's opener is cleared instead.
        const opened = window.open(url, "_blank");
        if (opened) opened.opener = null;
        return opened !== null;
      }
      // Another site: it gets no handle back on this page.
      tab.opener = null;
      tab.location.href = url;
      return true;
    },
    close: () => tab?.close(),
  };
}

/** Said when the browser blocked a tab twice over. */
export const TAB_BLOCKED = "Your browser blocked the new tab. Allow pop-ups for Outrunner and try again.";
