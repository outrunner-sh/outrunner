/**
 * Handoff packages in storage: a session on its way from one machine to
 * another (the agent's export → seed). A package sits in the private snapshots
 * bucket under its owner, from the moment the agent where the session ran
 * uploads it until the new session is made from it, then it is removed.
 *
 * Every path is built here from the signed-in user's id and a server-made
 * package id, never taken from a request, so no one can sign a URL into
 * someone else's package. The storage itself is injected, as for snapshots, so
 * this is tested without Supabase.
 */
import {
  HANDOFF_ARTIFACTS,
  type HandoffArtifact,
  type HandoffFile,
  HandoffManifest,
} from "@/lib/runtime/agent-protocol";
import type { SnapshotStorage } from "@/lib/runtime/storage/snapshots";

/** What a handoff needs of storage beyond signing URLs: reading the manifest
 *  the agent uploaded, and removing the package once it is used. */
export interface HandoffStorage extends SnapshotStorage {
  /** An object's text; null when there is none. */
  readText(path: string): Promise<string | null>;
  remove(paths: string[]): Promise<void>;
}

const FILE_NAMES: Record<HandoffArtifact, string> = {
  bundle: "worktree.bundle",
  patch: "uncommitted.patch",
  conversation: "conversation.jsonl",
  manifest: "handoff.json",
};

/** A package's downloads outlive any seed that waits on a box to start. */
const DOWNLOAD_TTL_SECONDS = 60 * 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether a value is a package id this server could have made. */
export function isHandoffId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** The object key of one of a package's files. */
export function handoffPath(ownerId: string, handoffId: string, artifact: HandoffArtifact): string {
  if (!UUID.test(ownerId) || !UUID.test(handoffId)) {
    throw new Error("refusing a handoff path outside an owner's packages");
  }
  return `handoffs/${ownerId}/${handoffId}/${FILE_NAMES[artifact]}`;
}

/** An upload URL for every file a package can hold: which ones the agent
 *  fills depends on the session (no commits of its own, no chat). */
export function mintHandoffUploads(
  storage: SnapshotStorage,
  ownerId: string,
  handoffId: string,
): Promise<HandoffFile[]> {
  return Promise.all(
    HANDOFF_ARTIFACTS.map(async (artifact) => {
      const { signedUrl } = await storage.createSignedUploadUrl(handoffPath(ownerId, handoffId, artifact));
      return { artifact, url: signedUrl };
    }),
  );
}

/** Why a package can't be used: gone, never finished, or not one this server
 *  understands. Its message is for the user. */
export class HandoffUnavailableError extends Error {}

/**
 * A finished package's manifest, and download URLs for the files it holds.
 * The manifest is uploaded last, so its presence means the rest is there.
 */
export async function loadHandoff(
  storage: HandoffStorage,
  ownerId: string,
  handoffId: string,
): Promise<{ manifest: HandoffManifest; downloads: HandoffFile[] }> {
  const text = await storage.readText(handoffPath(ownerId, handoffId, "manifest"));
  if (text === null) {
    throw new HandoffUnavailableError("The session's copy isn't there any more. Try again.");
  }
  let manifest: HandoffManifest;
  try {
    manifest = HandoffManifest.parse(JSON.parse(text));
  } catch {
    throw new HandoffUnavailableError("The session's copy couldn't be read. Update the Outrunner app and try again.");
  }
  const held: HandoffArtifact[] = ["patch"];
  if (manifest.bundle) held.push("bundle");
  if (manifest.conversation) held.push("conversation");
  const downloads = await Promise.all(
    held.map(async (artifact) => {
      const { signedUrl } = await storage.createSignedDownloadUrl(
        handoffPath(ownerId, handoffId, artifact),
        DOWNLOAD_TTL_SECONDS,
      );
      return { artifact, url: signedUrl };
    }),
  );
  return { manifest, downloads };
}

/** Remove a package, whichever of its files exist. */
export function removeHandoff(storage: HandoffStorage, ownerId: string, handoffId: string): Promise<void> {
  return storage.remove(HANDOFF_ARTIFACTS.map((artifact) => handoffPath(ownerId, handoffId, artifact)));
}
