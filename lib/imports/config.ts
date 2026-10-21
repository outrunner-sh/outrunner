/**
 * Importing the user's own agent setup from their Mac: where its archive is
 * uploaded (their archives/ folder in the snapshot bucket, so the desktop
 * app's upload check holds), and keeping it once uploaded — replacing any
 * earlier import's, whose archive is deleted.
 *
 * Its collaborators are passed in, so it tests without Next or a database.
 */

import type { AgentConfig } from "@/lib/db/agent-config";
import { ImportError } from "@/lib/imports/commit";
import type { ImportConfigCommitRequest } from "@/lib/runtime/import-scan";

/** The most MCP servers, and bytes of them, a setup keeps. */
const MAX_MCP_SERVERS = 50;
const MAX_MCP_BYTES = 256 * 1024;

/** Where an import's archive goes. */
export function configArchivePath(ownerId: string, id: string): string {
  return `archives/${ownerId}/agent-config/${id}.tar.gz`;
}

const ARCHIVE_PATH = /^archives\/([0-9a-f-]{36})\/agent-config\/[0-9a-f-]{36}\.tar\.gz$/;

export type ConfigDeps = {
  newId(): string;
  mintUpload(path: string): Promise<string>;
  storedSize(path: string): Promise<number | null>;
  save(config: AgentConfig): Promise<string | null>;
  remove(path: string): Promise<void>;
};

export async function planConfig(ownerId: string, deps: Pick<ConfigDeps, "newId" | "mintUpload">) {
  const path = configArchivePath(ownerId, deps.newId());
  return { path, url: await deps.mintUpload(path) };
}

export async function commitConfig(
  ownerId: string,
  req: ImportConfigCommitRequest,
  deps: Pick<ConfigDeps, "storedSize" | "save" | "remove">,
): Promise<void> {
  if (req.archive) {
    const owner = ARCHIVE_PATH.exec(req.archive.path)?.[1];
    if (owner !== ownerId) throw new ImportError("That isn't where your settings were to be uploaded.", 400);
    if ((await deps.storedSize(req.archive.path)) !== req.archive.size) {
      throw new ImportError("Your settings didn't finish uploading. Import them again.", 409);
    }
  }
  if (Object.keys(req.mcpServers).length > MAX_MCP_SERVERS || JSON.stringify(req.mcpServers).length > MAX_MCP_BYTES) {
    throw new ImportError("That's more MCP servers than a cloud computer takes.", 413);
  }
  const replaced = await deps.save({
    archive: req.archive ?? null,
    items: req.items,
    mcpServers: req.mcpServers,
    settings: req.settings,
  });
  if (replaced) {
    await deps.remove(replaced).catch((error: unknown) => console.warn(`Could not delete the old settings archive ${replaced}`, error));
  }
}
