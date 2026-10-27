/**
 * The Workspace Snapshot manifest — the contract.
 *
 * A Snapshot is a first-class, immutable object addressed ENTIRELY through its
 * manifest. Every consumer (Replay, Restore, Mission, analytics) reads
 * `manifest.json` and follows its pointers; nothing enumerates a storage prefix.
 * This keeps features decoupled from storage layout.
 *
 * Invariants encoded here:
 * - The manifest is POINTER-ONLY. It carries relative artifact filenames,
 *   checksums, sizes, counts, and small scalars — never blobs. Large payloads
 *   (conversation, cast, tree, the Summary's `filesTouched`) are separate
 *   storage artifacts, referenced by filename.
 * - The Tree is an INTERFACE, not a format: `tree.kind` declares the impl and
 *   Restore dispatches on it. v0 ships `git-bundle+patch`; adding OCI/ZFS/etc.
 *   later is purely additive (a new member of the discriminated union).
 *
 * This zod schema is the single source of truth for the manifest shape; the
 * TypeScript type is inferred from it (never hand-duplicated).
 */
import { z } from "zod";

/**
 * The named artifacts a Snapshot is composed of. This table is the ONE place
 * artifact filenames are defined; the storage path builder and any consumer
 * import from here rather than re-spelling the names (DRY across the codebase,
 * and — since Next mints the upload URLs — the Go agent never needs the scheme,
 * only its own local cast filename).
 */
export const SNAPSHOT_ARTIFACTS = {
  conversation: "conversation.jsonl",
  cast: "session.cast",
  bundle: "worktree.bundle",
  patch: "uncommitted.patch",
  summary: "summary.json",
  manifest: "manifest.json",
} as const;

export type SnapshotArtifact = keyof typeof SNAPSHOT_ARTIFACTS;

/**
 * Artifacts only some Snapshots have: a Codex session's raw rollout, next to
 * its translated conversation, so Restore can resume Codex itself. Kept out of
 * SNAPSHOT_ARTIFACTS, whose every key is minted for every archive: an agent
 * from before an optional artifact refuses an upload URL it doesn't know, so
 * one is asked for only of an agent that can make it. The agent uploads one
 * only when the session has it, and the manifest names only those uploaded.
 */
export const OPTIONAL_SNAPSHOT_ARTIFACTS = {
  rollout: "rollout.jsonl",
} as const;

export type OptionalSnapshotArtifact = keyof typeof OPTIONAL_SNAPSHOT_ARTIFACTS;

/** sha256 digest, formatted `sha256:<hex>` (matches the manifest's own notation). */
const Sha256 = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "expected a 'sha256:<hex>' digest");

/**
 * The filesystem capture, behind an interface. v0 is a git bundle (committed
 * history) plus a patch of the uncommitted working tree. Discriminated on
 * `kind` so Restore dispatches on the impl and future kinds are additive.
 */
export const SnapshotTree = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("git-bundle+patch"),
      bundle: z.literal(SNAPSHOT_ARTIFACTS.bundle),
      patch: z.literal(SNAPSHOT_ARTIFACTS.patch),
      /** The branch as the bundle names it, when the workspace's is another
       *  (an import whose branch was taken in the cloud). */
      ref: z.string().min(1).optional(),
    })
    .strict(),
  /** A session of several repositories: the bundle and patch are tars of one
   *  `<name>.bundle` / `<name>.patch` a checkout (runtime-agent
   *  snapshot/checkouts.go), each restored in its own folder. */
  z
    .object({
      kind: z.literal("git-bundles+patches"),
      bundle: z.literal(SNAPSHOT_ARTIFACTS.bundle),
      patch: z.literal(SNAPSHOT_ARTIFACTS.patch),
      checkouts: z
        .array(
          z
            .object({
              name: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/),
              fullName: z.string().min(1).optional(),
              baseBranch: z.string().min(1).optional(),
              lastCommit: z.string().nullable(),
            })
            .strict(),
        )
        .min(2)
        .max(5),
    })
    .strict(),
]);
export type SnapshotTree = z.infer<typeof SnapshotTree>;

/**
 * Aggregate token usage snapshotted at archive. A record of numbers (matching
 * the design's `{ "...": 0 }`) rather than the live `usage` event shape, since
 * this is a rollup, not a protocol frame.
 */
const ManifestTokenUsage = z.record(
  z.string(),
  z.number().int().nonnegative(),
);

/** Where an imported Snapshot came from: not a box's archive, but a session
 *  on someone's own Mac (lib/runtime/import-scan.ts). */
export const SnapshotOrigin = z
  .object({
    source: z.enum(["conductor", "claude-cli", "codex-cli", "outrunner-local"]),
    /** The scan's key for the session, "<agent>:<session id>". */
    key: z.string().min(1),
    /** The checkout the session worked in there; Restore moves the
     *  conversation's working directories from it to the worktree. */
    worktree: z.string().startsWith("/"),
    importedAt: z.string().min(1),
  })
  .strict();
export type SnapshotOrigin = z.infer<typeof SnapshotOrigin>;

/** How a stored artifact is encoded, by filename; absent is as is. */
export const SnapshotEncodings = z.record(z.string(), z.literal("gzip"));

export const SnapshotManifest = z
  .object({
    /** Contract version. Bump only on a breaking manifest change. */
    version: z.literal(1),

    workspaceId: z.string().min(1),
    runtimeVersion: z.string().min(1),
    claudeVersion: z.string().min(1),

    /**
     * Claude session id for `claude --continue` on Restore. Nullable: a
     * workspace may be archived before Claude ever produced a session. Restore
     * verification enforces presence before booting Claude.
     */
    sessionId: z.string().min(1).nullable(),

    // Pointers — relative artifact filenames (see SNAPSHOT_ARTIFACTS).
    conversation: z.literal(SNAPSHOT_ARTIFACTS.conversation),
    /** The terminal recording; an imported session has none. */
    cast: z.literal(SNAPSHOT_ARTIFACTS.cast).optional(),
    tree: SnapshotTree,
    summary: z.literal(SNAPSHOT_ARTIFACTS.summary),
    /** The raw Codex rollout, when the Snapshot has one. */
    rollout: z.literal(OPTIONAL_SNAPSHOT_ARTIFACTS.rollout).optional(),

    // Integrity — keyed by artifact filename, of the bytes as stored.
    checksums: z.record(z.string(), Sha256),
    sizes: z.record(z.string(), z.number().int().nonnegative()),
    /** Artifacts stored compressed (an import's), by filename. */
    encodings: SnapshotEncodings.optional(),
    /** Set on a Snapshot imported from someone's Mac. */
    origin: SnapshotOrigin.optional(),

    startedAt: z.string().min(1),
    archivedAt: z.string().min(1),

    /** Last committed sha; null when the worktree has no commits. */
    lastCommit: z.string().nullable(),
    /** Last assistant message (preview); null when there was none. */
    lastMessage: z.string().nullable(),
    tokenUsage: ManifestTokenUsage,
    /** COUNT of changed files. The file LIST lives in the Summary artifact. */
    changedFiles: z.number().int().nonnegative(),
  })
  .strict();

export type SnapshotManifest = z.infer<typeof SnapshotManifest>;

/** Parse-or-throw at a trust boundary (e.g. after reading manifest.json). */
export function parseManifest(value: unknown): SnapshotManifest {
  return SnapshotManifest.parse(value);
}
