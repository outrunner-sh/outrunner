/**
 * A session's chats in its Snapshots: an archive captures each chat's
 * conversation beside the main one (under chats/<id>/ of the Snapshot), the
 * manifest names each with its record, a restore brings each back, and an
 * archived session's chats are read from it (the replay page, the API).
 *
 * Pure, so it is unit-tested in Node.
 */

import type { ArchiveChat, RestoreChat } from "@/lib/runtime/agent-protocol";
import { chatArtifactName, type SnapshotManifest } from "@/lib/runtime/snapshot/manifest";
import type { SessionChat } from "@/lib/session/chats";

/** Where an archive puts a chat's artifacts under its Snapshot's prefix: its
 *  conversation, and a Codex chat's rollout. */
export function chatUploadPaths(prefix: string, chat: SessionChat): { conversation: string; rollout?: string } {
  return {
    conversation: `${prefix}${chatArtifactName(chat.id, "conversation")}`,
    ...(chat.agent === "codex" && { rollout: `${prefix}${chatArtifactName(chat.id, "rollout")}` }),
  };
}

/** A chat as an archive asks the agent to capture it: its record, and the
 *  signed URLs its artifacts go to. */
export function archiveChat(chat: SessionChat, urls: { conversation: string; rollout?: string }): ArchiveChat {
  return {
    chatId: chat.id,
    name: chat.name,
    kind: chat.kind === "side" ? "side" : "chat",
    forkedFrom: chat.forkedFrom,
    agent: chat.agent,
    model: chat.model ? { provider: chat.model.model.provider, id: chat.model.model.id, effort: chat.model.effort } : null,
    conversation: urls.conversation,
    ...(urls.rollout && { rollout: urls.rollout }),
  };
}

/**
 * The chats a restore brings back: each the Snapshot holds that the session
 * still has (one deleted since stays gone), with signed download URLs for
 * its artifacts (`download` mints one for a Snapshot filename).
 */
export async function restoreChats(
  manifest: SnapshotManifest,
  kept: readonly SessionChat[],
  download: (filename: string) => Promise<string>,
): Promise<RestoreChat[]> {
  const ids = new Set(kept.map((chat) => chat.id));
  const chats = (manifest.chats ?? []).filter((chat) => ids.has(chat.id));
  return Promise.all(
    chats.map(async (chat) => ({
      chatId: chat.id,
      agent: chat.agent,
      sessionId: chat.sessionId,
      conversation: await download(chat.conversation),
      ...(chat.rollout && { rollout: await download(chat.rollout) }),
    })),
  );
}
