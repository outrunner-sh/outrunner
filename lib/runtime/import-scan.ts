/**
 * Importing sessions from someone's Mac: what `runtime-agent import` reports
 * (a scan, a capture), and what the web app sends the import routes.
 *
 * The scan and capture shapes mirror runtime-agent/internal/localimport; both
 * sides check lib/runtime/import-scan.fixtures.json, so neither drifts alone.
 */
import { z } from "zod";

import { AgentName } from "@/lib/runtime/agent-protocol";

export const IMPORT_SOURCES = ["conductor", "claude-cli", "codex-cli", "outrunner-local"] as const;
export const ImportSource = z.enum(IMPORT_SOURCES);
export type ImportSource = z.infer<typeof ImportSource>;

/** Why something can't be imported. The server adds those only it can know:
 *  no-repo-access, branch-taken, already-imported. */
export const SKIP_REASONS = [
  "no-github-remote",
  "no-repo-access",
  "worktree-missing",
  "branch-missing",
  "branch-taken",
  "too-large",
  "already-imported",
  "unportable-mcp",
  "unknown-conductor-schema",
  "source-unreadable",
  "transcript-missing",
] as const;
export const SkipReason = z.enum(SKIP_REASONS);
export type SkipReason = z.infer<typeof SkipReason>;

export const ImportSkip = z.object({
  reason: SkipReason,
  /** For the user: what exactly was missing or wrong. */
  detail: z.string().optional(),
});
export type ImportSkip = z.infer<typeof ImportSkip>;

/** A session's key: "<agent>:<session id>". */
export const SESSION_KEY = /^(claude|codex):[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SessionKey = z.string().regex(SESSION_KEY);

/** A GitHub repository, "owner/name". */
const RepoFullName = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/);

const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const ScannedSession = z
  .object({
    key: SessionKey,
    source: ImportSource,
    agent: AgentName,
    sessionId: z.string().min(1),
    title: z.string(),
    model: z.string().optional(),
    cwd: z.string(),
    worktree: z.string().optional(),
    repo: RepoFullName.optional(),
    branch: z.string().optional(),
    baseBranch: z.string().optional(),
    checkedOut: z.boolean(),
    dirty: z.boolean(),
    unpushed: z.number().int().nonnegative(),
    transcript: z.string(),
    transcriptBytes: z.number().int().nonnegative(),
    startedAt: z.string().optional(),
    updatedAt: z.string().optional(),
    lastMessage: z.string().optional(),
    conductorState: z.string().optional(),
    skip: ImportSkip.optional(),
  })
  .strict();
export type ScannedSession = z.infer<typeof ScannedSession>;

export const ImportScan = z
  .object({
    version: z.literal(1),
    scannedAt: z.string(),
    sources: z.array(
      z.object({ id: ImportSource, found: z.boolean(), skip: ImportSkip.optional() }).strict(),
    ),
    sessions: z.array(ScannedSession),
  })
  .strict();
export type ImportScan = z.infer<typeof ImportScan>;

/** The artifacts a capture writes, by kind. */
export const IMPORT_ARTIFACTS = ["bundle", "patch", "conversation", "rollout"] as const;
export const ImportArtifactKind = z.enum(IMPORT_ARTIFACTS);
export type ImportArtifactKind = z.infer<typeof ImportArtifactKind>;

export const CapturedArtifact = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1),
    sha256: Sha256,
    size: z.number().int().nonnegative(),
    encoding: z.literal("gzip").optional(),
  })
  .strict();

export const ImportCapture = z
  .object({
    session: ScannedSession,
    lastCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
    changedFiles: z.number().int().nonnegative(),
    artifacts: z.partialRecord(ImportArtifactKind, CapturedArtifact),
  })
  .strict();
export type ImportCapture = z.infer<typeof ImportCapture>;

export const ImportCaptureSkip = z.object({ skip: ImportSkip }).strict();

// ---------------------------------------------------------------------------
// The import routes.
// ---------------------------------------------------------------------------

/** Sessions one plan may take. */
export const MAX_IMPORT_SESSIONS = 50;

/** POST /api/imports: the sessions the user picked, as the scan found them. */
export const ImportPlanRequest = z
  .object({
    sessions: z
      .array(
        z
          .object({
            key: SessionKey,
            source: ImportSource,
            agent: AgentName,
            repo: RepoFullName,
            branch: z.string().min(1).max(255),
            /** The branch to import it as, when the user named one. */
            branchAs: z.string().min(1).max(255).optional(),
            /** Import it again though it was imported before. */
            again: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_IMPORT_SESSIONS),
  })
  .strict();
export type ImportPlanRequest = z.infer<typeof ImportPlanRequest>;

/** Where one artifact is to be uploaded. */
export const ImportUpload = z.object({ url: z.string(), path: z.string() });

/** What the plan says of each session. */
export const ImportPlanItem = z.discriminatedUnion("status", [
  z.object({
    key: SessionKey,
    status: z.literal("ready"),
    workspaceId: z.string().uuid(),
    projectId: z.string().uuid(),
    /** The branch it is imported as: its own, or another when that was taken. */
    branch: z.string(),
    renamed: z.boolean(),
    importedAt: z.string(),
    uploads: z.partialRecord(ImportArtifactKind, ImportUpload),
  }),
  z.object({ key: SessionKey, status: z.literal("skipped"), skip: ImportSkip }),
]);
export type ImportPlanItem = z.infer<typeof ImportPlanItem>;

const ArtifactReceipt = z
  .object({ sha256: Sha256, size: z.number().int().nonnegative(), encoding: z.literal("gzip").optional() })
  .strict();

/** POST /api/imports/commit: one session, its artifacts uploaded. */
export const ImportCommitRequest = z
  .object({
    workspaceId: z.string().uuid(),
    projectId: z.string().uuid(),
    importedAt: z.string().datetime({ offset: true }),
    key: SessionKey,
    source: ImportSource,
    agent: AgentName,
    sessionId: z.string().min(1),
    /** The branch it is imported as, and the one its bundle names. */
    branch: z.string().min(1).max(255),
    bundleRef: z.string().min(1).max(255),
    title: z.string().max(200),
    /** The checkout it worked in on the Mac. */
    worktree: z.string().startsWith("/"),
    startedAt: z.string().optional(),
    lastCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
    unpushed: z.number().int().nonnegative(),
    changedFiles: z.number().int().nonnegative(),
    lastMessage: z.string().max(2000).optional(),
    artifacts: z
      .object({
        bundle: ArtifactReceipt,
        patch: ArtifactReceipt,
        conversation: ArtifactReceipt,
        rollout: ArtifactReceipt.optional(),
      })
      .strict(),
  })
  .strict()
  .refine((v) => v.key === `${v.agent}:${v.sessionId}`, { message: "key must be <agent>:<sessionId>", path: ["key"] });
export type ImportCommitRequest = z.infer<typeof ImportCommitRequest>;
