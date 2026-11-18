import { localImagePath } from "@/lib/runtime/chat-image";
import { canvasLinkPath } from "@/lib/session/canvas-link";

/**
 * Where a link in a reply or a Canvas document goes (components/markdown.tsx):
 *
 * - `canvas`: a file in the session's Canvas, shown there.
 * - `box-file`: any other path, a file on the session's box, downloaded:
 *   the agent can't reach the user's computer, so this is how a file it
 *   made gets there.
 * - `box-server`: a server on the box's localhost (`http://localhost:3000/x`),
 *   which on the user's computer is nothing or something else entirely:
 *   opened through the port's preview link, at the same page.
 * - `no-box`: a path with no box to read it from (a session on this Mac, a
 *   replay): not a link, as the app has no page there and following it
 *   would strand the user on a 404.
 * - `as-written`: a web page, mail, an anchor.
 */
export type ReplyLink =
  | { kind: "canvas"; workspaceId: string; path: string }
  | { kind: "box-file"; workspaceId: string; path: string }
  | { kind: "box-server"; workspaceId: string; port: number; page: string }
  | { kind: "no-box"; path: string }
  | { kind: "as-written" };

/** Where `href` goes, from a reply of the session whose box is
 *  `boxWorkspaceId` (null for none to read), or from the Canvas document
 *  `doc`. */
export function replyLink(
  href: string | undefined,
  boxWorkspaceId: string | null,
  doc?: { workspaceId: string; path: string } | null,
): ReplyLink {
  const canvasWorkspace = doc?.workspaceId || boxWorkspaceId;
  const canvasPath = canvasLinkPath(href, canvasWorkspace, doc?.path);
  if (canvasPath && canvasWorkspace) return { kind: "canvas", workspaceId: canvasWorkspace, path: canvasPath };
  const server = boxWorkspaceId ? localServer(href) : null;
  if (server && boxWorkspaceId) return { kind: "box-server", workspaceId: boxWorkspaceId, ...server };
  const path = localImagePath(href);
  if (!path) return { kind: "as-written" };
  return boxWorkspaceId ? { kind: "box-file", workspaceId: boxWorkspaceId, path } : { kind: "no-box", path };
}

/** The names a box's own loopback goes by in a link. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/** The port and page (path, query and fragment) of a link to a server on
 *  loopback; null for any other link. */
function localServer(href: string | undefined): { port: number; page: string } | null {
  let url: URL;
  try {
    url = new URL(href ?? "");
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !LOOPBACK.has(url.hostname)) return null;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return { port, page: `${url.pathname}${url.search}${url.hash}` };
}

/** `page` (a path, with any query and fragment) on the preview at
 *  `preview`, whose own path and query (a credential, on some providers)
 *  are kept. */
export function previewPage(preview: string, page: string): string {
  const url = new URL(preview);
  const at = new URL(page, "http://page.invalid");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${at.pathname}`;
  for (const [name, value] of at.searchParams) url.searchParams.append(name, value);
  url.hash = at.hash;
  return url.toString();
}
