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

/** Each source as the user knows it. */
export const IMPORT_SOURCE_LABELS: Record<ImportSource, string> = {
  conductor: "Conductor",
  "claude-cli": "Claude Code",
  "codex-cli": "Codex",
  "outrunner-local": "Outrunner on this Mac",
};

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

const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/);
/** A path in a checkout: relative, and never out of it. */
const CheckoutPath = z
  .string()
  .min(1)
  .max(512)
  .refine((p) => !p.startsWith("/") && !p.split("/").some((part) => part === ".." || part === "." || part === ""), {
    message: "a path in the checkout",
  });

export const ProjectScripts = z
  .object({ setup: z.string().optional(), run: z.string().optional(), archive: z.string().optional() })
  .strict();
export type ProjectScripts = z.infer<typeof ProjectScripts>;

/** What a repository's cloud sessions could take from the Mac: names only. */
export const ScannedProjectEnv = z
  .object({
    repo: RepoFullName,
    root: z.string().optional(),
    vars: z.array(z.object({ name: EnvName, shared: z.boolean() }).strict()),
    files: z.array(z.object({ path: CheckoutPath, names: z.array(EnvName), bytes: z.number().int() }).strict()),
    scripts: ProjectScripts.optional(),
  })
  .strict();
export type ScannedProjectEnv = z.infer<typeof ScannedProjectEnv>;

/** A file or folder of the user's own agent setup, by name. */
export const ScannedConfigItem = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["claude-md", "skill", "agent", "command", "agents-md"]),
    name: z.string(),
    path: z.string(),
    bytes: z.number().int().nonnegative(),
    omitted: z.number().int().optional(),
    skip: ImportSkip.optional(),
  })
  .strict();
export type ScannedConfigItem = z.infer<typeof ScannedConfigItem>;

/** One of Claude's MCP servers; its keys by name only. */
export const ScannedMCPServer = z
  .object({
    name: z.string().min(1),
    transport: z.string(),
    command: z.string().optional(),
    url: z.string().optional(),
    envNames: z.array(z.string()),
    headerNames: z.array(z.string()),
    skip: ImportSkip.optional(),
  })
  .strict();
export type ScannedMCPServer = z.infer<typeof ScannedMCPServer>;

export const ScannedAgentConfig = z
  .object({ items: z.array(ScannedConfigItem), mcpServers: z.array(ScannedMCPServer), plugins: z.array(z.string()) })
  .strict();
export type ScannedAgentConfig = z.infer<typeof ScannedAgentConfig>;

export const ImportScan = z
  .object({
    version: z.literal(1),
    scannedAt: z.string(),
    sources: z.array(
      z.object({ id: ImportSource, found: z.boolean(), skip: ImportSkip.optional() }).strict(),
    ),
    sessions: z.array(ScannedSession),
    projects: z.array(ScannedProjectEnv),
    config: ScannedAgentConfig,
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

/** The values of what the user picked of a repository's environment. */
export const ImportEnvCapture = z
  .object({
    repo: RepoFullName,
    env: z.record(EnvName, z.string()),
    files: z.record(CheckoutPath, z.string()),
    scripts: ProjectScripts.optional(),
  })
  .strict();
export type ImportEnvCapture = z.infer<typeof ImportEnvCapture>;

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

/** What of the user's setup was picked: the files' archive (uploaded), and
 *  the MCP servers and plugin settings in full, keys and all. */
export const ImportConfigCapture = z
  .object({
    archive: CapturedArtifact.optional(),
    items: z.array(z.string()),
    mcpServers: z.record(z.string().min(1), z.record(z.string(), z.unknown())),
    settings: z.partialRecord(z.enum(["enabledPlugins", "extraKnownMarketplaces"]), z.unknown()),
  })
  .strict();
export type ImportConfigCapture = z.infer<typeof ImportConfigCapture>;

/** POST /api/imports/environment: a repository's picked environment, values
 *  and all, to keep sealed for its cloud sessions. */
export const ImportEnvironmentRequest = ImportEnvCapture;
export type ImportEnvironmentRequest = ImportEnvCapture;

/** POST /api/imports/config/commit: the user's picked setup, its archive
 *  uploaded where POST /api/imports/config said. */
export const ImportConfigCommitRequest = z
  .object({
    archive: z.object({ path: z.string().min(1), sha256: Sha256, size: z.number().int().positive() }).strict().optional(),
    items: z.array(z.string().min(1).max(256)).max(500),
    mcpServers: z.record(z.string().min(1).max(128), z.record(z.string(), z.unknown())),
    settings: z.partialRecord(z.enum(["enabledPlugins", "extraKnownMarketplaces"]), z.unknown()),
  })
  .strict();
export type ImportConfigCommitRequest = z.infer<typeof ImportConfigCommitRequest>;
