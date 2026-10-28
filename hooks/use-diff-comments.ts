"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

import { tabStorage } from "@/lib/session/first-prompt";
import {
  addComment,
  clearComments,
  type CommentQuote,
  type DiffComment,
  readComments,
  removeComment,
  subscribeComments,
} from "@/lib/session/diff-comments";

const NONE: DiffComment[] = [];

/**
 * The session's comments on its diff (lib/session/diff-comments.ts), and the
 * ways to change them. The Changes view writes them and the composer sends
 * them; both read the one list, so a comment added in one shows in the other
 * at once.
 */
export function useDiffComments(workspaceId: string) {
  const subscribe = useCallback((onChange: () => void) => subscribeComments(workspaceId, onChange), [workspaceId]);
  const items = useSyncExternalStore(
    subscribe,
    () => readComments(tabStorage(), workspaceId),
    // The server has no tab: none, until the page takes over.
    () => NONE,
  );
  return useMemo(
    () => ({
      items,
      add: (comment: CommentQuote) => addComment(tabStorage(), workspaceId, comment),
      remove: (id: string) => removeComment(tabStorage(), workspaceId, id),
      clear: (ids: string[]) => clearComments(tabStorage(), workspaceId, ids),
    }),
    [items, workspaceId],
  );
}

export type DiffCommentsState = ReturnType<typeof useDiffComments>;
