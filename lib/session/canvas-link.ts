import { localImagePath } from "@/lib/runtime/chat-image";
import { canvasPathFrom, canvasPathIn } from "@/lib/session/canvas";

/** Resolve a chat or Canvas document link only within this session's Canvas. */
export function canvasLinkPath(href: string | undefined, workspaceId: string | null, documentPath?: string): string | null {
  const path = localImagePath(href);
  if (!path || !workspaceId || href?.startsWith("#")) return null;
  return (documentPath ? canvasPathFrom(documentPath, path) : null) || canvasPathIn(path, workspaceId);
}
