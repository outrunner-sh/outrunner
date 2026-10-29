import type { PreviewPage } from "./wire.ts";

/**
 * The pages a preview shows in place of the box's server (lib/previews/proxy.ts):
 * plain HTML of Outrunner's own, with nothing of the box's in them. Node
 * runs this as is for the server, so it imports nothing from the app.
 */

const COPY: Record<PreviewPage, { title: string; message: string }> = {
  missing: {
    title: "No such preview",
    message: "This preview link was deleted, or never was. Ask whoever shared it for a new one.",
  },
  ended: {
    title: "This session has ended",
    message: "The session this preview showed was deleted, and its server with it.",
  },
  denied: {
    title: "You can't open this preview",
    message:
      "It's for members of the session's org who can see its repository. Ask an admin of the org for access, or ask the session's owner to share it another way.",
  },
  asleep: {
    title: "This session is asleep",
    message: "Its sandbox is paused, so the server this preview shows isn't running. It wakes when its owner opens the session in Outrunner.",
  },
  starting: {
    title: "This session is waking up",
    message: "Its sandbox is starting. This page tries again in a few seconds.",
  },
  unsupported: {
    title: "This preview can't open",
    message: "The session runs where Outrunner can't reach its servers from the web.",
  },
  error: {
    title: "Outrunner couldn't open this preview",
    message: "Something went wrong on Outrunner's side, not the session's. This page tries again in a few seconds.",
  },
  unavailable: {
    title: "Nothing answered",
    message: "The session is awake, but nothing answered on this preview's port. Is its server running? This page tries again in a few seconds.",
  },
};

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** How often a page that says to wait loads itself again, in seconds. */
const REFRESH: Partial<Record<PreviewPage, number>> = { asleep: 15, starting: 4, unavailable: 5, error: 5 };

export function renderPreviewPage(
  page: PreviewPage | "expired" | "woke",
  options: { canWake?: boolean; path?: string; signInUrl?: string; message?: string } = {},
): string {
  const copy =
    page === "expired"
      ? { title: "That sign-in link has expired", message: "Sign-in links to a preview work once, for a minute." }
      : page === "woke"
        ? { title: "Waking the session", message: "Its sandbox is starting. You'll be taken back in a few seconds." }
        : COPY[page];
  const message = options.message ?? copy.message;
  const refresh = page === "woke" ? 4 : page === "asleep" && options.canWake ? undefined : REFRESH[page as PreviewPage];
  const back = options.path ?? "/";
  const actions: string[] = [];
  if (page === "asleep" && options.canWake) {
    actions.push(
      `<form method="post" action="/__outrunner/wake?r=${escape(encodeURIComponent(back))}"><button type="submit">Wake the session</button></form>`,
    );
  }
  if (page === "expired" && options.signInUrl) {
    actions.push(`<p><a href="${escape(`${options.signInUrl}?r=${encodeURIComponent(back)}`)}">Sign in again</a></p>`);
  }
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    (refresh ? `<meta http-equiv="refresh" content="${refresh};url=${escape(back)}">` : "") +
    `<title>${escape(copy.title)} · Outrunner preview</title><style>` +
    `body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#222}` +
    `h1{font-size:1.25rem}small{color:#777}button{font:inherit;padding:.4rem .9rem;border-radius:.4rem;border:1px solid #888;background:#fff;cursor:pointer}` +
    `@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}button{background:#222;color:#ddd}}a{color:inherit}` +
    `</style></head><body><h1>${escape(copy.title)}</h1><p>${escape(message)}</p>${actions.join("")}` +
    `<p><small>An Outrunner preview</small></p></body></html>`
  );
}

/** The headers every page of Outrunner's on a preview's host goes with:
 *  never cached (a page saying "asleep" mustn't outlive the nap), never
 *  framed, nothing run. */
export const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
} as const;
