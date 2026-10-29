/**
 * Put a prompt's attachments on the box and name them in the prompt.
 *
 * Both send paths use this so they cannot drift: the home composer (which
 * provisions a workspace, then sends its first prompt) and the in-session
 * composer (which sends into a running one).
 */

import { getAttachments, markMaterialized, readAttachmentBytes } from "@/lib/db/attachments";
import { attachmentFilenames, isImage, promptWithAttachments } from "@/lib/runtime/attachments";
import type { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";

/**
 * Write the given attachments into the workspace, returning the prompt with
 * their paths prepended.
 *
 * Returns the prompt unchanged when there is nothing to attach, and throws only
 * if the files exist but cannot be written — sending a prompt that references
 * files which never arrived would leave Claude looking for them.
 *
 * `attachmentIds` comes from the client, so the rows are re-read through RLS:
 * another owner's id simply does not resolve, and anything unresolved is
 * silently dropped rather than trusted.
 */
export async function materializeAttachments(input: {
  provider: ComputerRuntimeProvider;
  sandboxId: string;
  worktreePath: string;
  workspaceId: string;
  attachmentIds: string[];
  prompt: string;
}): Promise<string> {
  if (input.attachmentIds.length === 0) return input.prompt;

  const attachments = await getAttachments(input.attachmentIds);
  if (attachments.length === 0) return input.prompt;

  // Two files called screenshot.png must not overwrite each other on the box,
  // in one message or across messages.
  const names = attachmentFilenames(attachments);
  const files = await Promise.all(
    attachments.map(async (attachment, index) => ({
      filename: names[index],
      bytes: await readAttachmentBytes(attachment.storagePath),
    })),
  );

  await input.provider.writeWorkspaceAttachments(input.sandboxId, input.worktreePath, files);
  await markMaterialized(
    attachments.map((a) => a.id),
    input.workspaceId,
  );

  return promptWithAttachments(
    input.prompt,
    names.map((name, index) => ({ name, image: isImage(attachments[index].contentType) })),
  );
}
