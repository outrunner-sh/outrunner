/**
 * Snapshot object-storage plumbing: private bucket + signed-URL helpers. The
 * archive/replay/restore flows that call these are built on top of M3 and live
 * elsewhere.
 */
export {
  mintSnapshotUpload,
  mintSnapshotDownloadUrl,
  type SnapshotStorage,
  type SnapshotUploadTarget,
  type SnapshotUploadPlan,
  type SnapshotUploadUrl,
} from "@/lib/runtime/storage/snapshots";
