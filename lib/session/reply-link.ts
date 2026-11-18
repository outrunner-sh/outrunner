import { localImagePath } from "@/lib/runtime/chat-image";
import { canvasLinkPath } from "@/lib/session/canvas-link";

/**
 * Where a link in a reply or a Canvas document goes (components/markdown.tsx):
 *
 * - `canvas`: a file in the session's Canvas, shown there.
 * - `box-file`: any other path, a file on the session's box, downloaded:
 *   the agent can't reach the user's computer, so this is how a file it
 *   made gets there.
 * - `no-box`: a path with no box to read it from (a session on this Mac, a
 *   replay): not a link, as the app has no page there and following it
 *   would strand the user on a 404.
 * - `as-written`: a web page, mail, an anchor.
 */
export type ReplyLink =
  | { kind: "canvas"; workspaceId: string; path: string }
  | { kind: "box-file"; workspaceId: string; path: string }
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
  const path = localImagePath(href);
  if (!path) return { kind: "as-written" };
  return boxWorkspaceId ? { kind: "box-file", workspaceId: boxWorkspaceId, path } : { kind: "no-box", path };
}
