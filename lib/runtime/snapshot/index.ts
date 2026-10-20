/**
 * Workspace Snapshot foundations — the manifest contract, storage path scheme,
 * frozen Summary mirror, and persisted-row domain types. The archive / replay /
 * restore flows that produce and consume Snapshots are built on top of these
 * (and on M3's Workspace Session) and live elsewhere.
 */
export {
  OPTIONAL_SNAPSHOT_ARTIFACTS,
  SNAPSHOT_ARTIFACTS,
  SnapshotManifest,
  SnapshotTree,
  parseManifest,
  type OptionalSnapshotArtifact,
  type SnapshotArtifact,
} from "@/lib/runtime/snapshot/manifest";
export {
  archivedAtSegment,
  snapshotPrefix,
  snapshotArtifactPath,
  snapshotArtifactPaths,
} from "@/lib/runtime/snapshot/paths";
export { WorkspaceSummary } from "@/lib/runtime/snapshot/summary";
export type {
  ArchivePolicy,
  WorkspaceSnapshot,
} from "@/lib/runtime/snapshot/types";
