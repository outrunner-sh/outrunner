"use client";

import { CloudUpload, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { AgentSetupPicker } from "@/components/import-setup-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { postJson } from "@/lib/client/post-json";
import { importConfig, importScan, importSession } from "@/lib/desktop/local-runtime";
import {
  type ConfigPick,
  configInScan,
  configPickSecrets,
  hasConfigPick,
  importAgentConfig,
  importSessions,
  type ImportProgress,
  offeredSessions,
  skipText,
} from "@/lib/imports/client";
import { isDesktopApp } from "@/lib/is-desktop";
import type {
  ImportCommitRequest,
  ImportConfigCommitRequest,
  ImportPlanItem,
  ImportPlanRequest,
  ImportScan,
  ImportSource,
  ScannedSession,
} from "@/lib/runtime/import-scan";

const noopSubscribe = () => () => {};

const SOURCE_LABEL: Record<ImportSource, string> = {
  conductor: "Conductor",
  "claude-cli": "Claude Code",
  "codex-cli": "Codex",
  "outrunner-local": "Outrunner on this Mac",
};

const STATE_LABEL: Record<ImportProgress["state"], string> = {
  waiting: "Waiting",
  uploading: "Uploading",
  saving: "Saving",
  done: "Imported",
  skipped: "Skipped",
  failed: "Failed",
};

/**
 * Moving work from this Mac to the cloud: the desktop app finds sessions
 * (Conductor, Claude Code, Codex) and the user's own agent setup; the user
 * picks what to bring. Each session becomes an archived cloud session, resumed
 * from its page; the setup is kept, its MCP keys encrypted, for every session
 * to start with. A project's environment isn't picked here: the new-session
 * form offers it as the project's first session starts.
 */
export function LocalImport() {
  const desktop = useSyncExternalStore(noopSubscribe, isDesktopApp, () => false);
  // Each "Scan again" is a new round; a round is scanning until its result
  // lands, and the last scan stays on screen meanwhile.
  const [round, setRound] = useState(0);
  const [result, setResult] = useState<{ round: number; scan: ImportScan | null; error: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [branchAs, setBranchAs] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Record<string, ImportProgress>>({});
  const [rawConfigPick, setConfigPick] = useState<ConfigPick>({ items: [], mcp: [], plugins: false });
  const [consent, setConsent] = useState(false);
  const [setupNote, setSetupNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    let live = true;
    importScan().then(
      (scan) => live && setResult({ round, scan, error: null }),
      (e: unknown) =>
        live &&
        setResult((last) => ({ round, scan: last?.scan ?? null, error: e instanceof Error ? e.message : String(e) })),
    );
    return () => {
      live = false;
    };
  }, [desktop, round]);

  const scan = result?.scan ?? null;
  const scanning = desktop && result?.round !== round;
  const rescan = () => setRound((r) => r + 1);
  const shownError = error ?? result?.error ?? null;

  const { importable, blocked } = useMemo(() => offeredSessions(scan?.sessions ?? []), [scan]);

  const toggle = (key: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Only what this scan still offers: a pick the last scan had but this one
  // doesn't no longer shows, so it must not be imported either.
  const configPick = useMemo(() => configInScan(rawConfigPick, scan), [rawConfigPick, scan]);
  const secrets = configPickSecrets(configPick);
  const pickedSetup = hasConfigPick(configPick);
  const canImport = (picked.size > 0 || pickedSetup) && (!secrets || consent) && !scanning && !importing;

  const importSetup = async () => {
    const config = await importAgentConfig(configPick, {
      plan: async () => (await postJson<{ upload: { path: string; url: string } }>("/api/imports/config", {})).upload,
      capture: importConfig,
      commit: (request: ImportConfigCommitRequest) => postJson("/api/imports/config/commit", request),
    });
    setSetupNote({
      ok: config.ok,
      text: `Your agent setup: ${config.ok ? "kept" : "not imported"}${config.message ? `. ${config.message}` : ""}`,
    });
    if (config.ok) {
      setConfigPick({ items: [], mcp: [], plugins: false });
      // With the picks gone, the agreement they were made under goes too:
      // the next secret picked has to be agreed to on its own.
      setConsent(false);
    }
  };

  const start = async () => {
    setImporting(true);
    setError(null);
    try {
      // The setup first: quick, and what the sessions start with.
      if (pickedSetup) await importSetup();
      if (picked.size === 0) return;
      await importSessions(
        importable.filter((s) => picked.has(s.key)),
        { branchAs: Object.fromEntries(Object.entries(branchAs).filter(([k, v]) => picked.has(k) && v.trim())) },
        {
          plan: async (request: ImportPlanRequest) =>
            (await postJson<{ items: ImportPlanItem[] }>("/api/imports", request)).items,
          capture: importSession,
          commit: (request: ImportCommitRequest) =>
            postJson<{ workspace: { id: string } }>("/api/imports/commit", request),
          onProgress: (p) => setProgress((current) => ({ ...current, [p.key]: p })),
        },
      );
      setPicked(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  if (!desktop) {
    return (
      <Page>
        <p className="text-sm text-muted-foreground">
          Importing reads the sessions on your Mac, so it runs in the Outrunner Mac app. Open it there to bring
          over your Conductor, Claude Code and Codex sessions.
        </p>
      </Page>
    );
  }

  const found = scan?.sources.filter((s) => s.found) ?? [];
  return (
    <Page
      action={
        <Button variant="outline" size="sm" onClick={rescan} disabled={scanning || importing}>
          <RefreshCw className={scanning ? "animate-spin" : undefined} />
          Scan again
        </Button>
      }
    >
      {scan && (
        <p className="text-sm text-muted-foreground">
          {found.length === 0
            ? "No Conductor, Claude Code or Codex sessions on this Mac."
            : `Found sessions from ${found.map((s) => SOURCE_LABEL[s.id]).join(", ")}.`}
          {scan.sources
            .filter((s) => s.skip)
            .map((s) => ` ${SOURCE_LABEL[s.id]}: ${skipText(s.skip!)}`)
            .join("")}
        </p>
      )}
      {shownError && <p className="text-sm text-destructive">{shownError}</p>}

      {scanning && !scan ? (
        <p className="text-sm text-muted-foreground">Looking for sessions on this Mac…</p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-md border border-border/60">
          {importable.length === 0 && (
            <li className="p-3 text-sm text-muted-foreground">No sessions here can be imported.</li>
          )}
          {importable.map((s) => (
            <SessionRow
              key={s.key}
              session={s}
              picked={picked.has(s.key)}
              onToggle={() => toggle(s.key)}
              branchAs={branchAs[s.key] ?? ""}
              onBranchAs={(v) => setBranchAs((current) => ({ ...current, [s.key]: v }))}
              progress={progress[s.key]}
              disabled={importing}
            />
          ))}
        </ul>
      )}

      {blocked.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {blocked.length} {blocked.length === 1 ? "session" : "sessions"} can&apos;t be imported
          </summary>
          <ul className="mt-2 space-y-1">
            {blocked.map((s) => (
              <li key={s.key} className="text-muted-foreground">
                <span className="text-foreground">{s.title || s.sessionId}</span> · {SOURCE_LABEL[s.source]} ·{" "}
                {skipText(s.skip!)}
              </li>
            ))}
          </ul>
        </details>
      )}

      {scan && (
        <AgentSetupPicker config={scan.config} pick={configPick} onChange={setConfigPick} disabled={importing} />
      )}

      {setupNote && (
        <p className={`text-xs ${setupNote.ok ? "text-muted-foreground" : "text-destructive"}`}>{setupNote.text}</p>
      )}

      <div className="space-y-3 border-t border-border/60 pt-4">
        <p className="max-w-xl text-xs text-muted-foreground">
          Each session&apos;s unpushed commits, uncommitted changes and full conversation are uploaded to your
          Outrunner cloud. A conversation can include anything its agent read, secrets too.
        </p>
        {secrets && (
          <label className="flex max-w-xl items-start gap-2 text-xs">
            <input type="checkbox" className="mt-0.5" checked={consent} onChange={() => setConsent(!consent)} />
            <span>
              Store the MCP keys I picked, encrypted, in Outrunner&apos;s cloud, and give them to my cloud sessions,
              where the agent can read them.
            </span>
          </label>
        )}
        <div className="flex justify-end">
          <Button disabled={!canImport} onClick={() => void start()}>
            <CloudUpload />
            {importing ? "Importing…" : "Import"}
          </Button>
        </div>
      </div>
    </Page>
  );
}

function Page({ action, children }: { action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Import from this Mac</h1>
        {action}
      </div>
      {children}
    </div>
  );
}

function SessionRow({
  session: s,
  picked,
  onToggle,
  branchAs,
  onBranchAs,
  progress,
  disabled,
}: {
  session: ScannedSession;
  picked: boolean;
  onToggle: () => void;
  branchAs: string;
  onBranchAs: (value: string) => void;
  progress?: ImportProgress;
  disabled: boolean;
}) {
  const facts = [
    s.unpushed > 0 && `${s.unpushed} unpushed ${s.unpushed === 1 ? "commit" : "commits"}`,
    s.checkedOut && s.dirty && "uncommitted changes",
    !s.checkedOut && "its folder is on another branch: committed work only",
    `${(s.transcriptBytes / 1_000_000).toFixed(1)} MB conversation`,
  ].filter(Boolean);
  return (
    <li className="flex items-start gap-3 p-3">
      <input
        type="checkbox"
        className="mt-1"
        checked={picked}
        onChange={onToggle}
        disabled={disabled || progress?.state === "done"}
        aria-label={`Import ${s.title || s.sessionId}`}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{s.title || s.sessionId}</span>
          <Badge variant="outline">{SOURCE_LABEL[s.source]}</Badge>
          {s.agent === "codex" && <Badge variant="outline">Codex</Badge>}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {s.repo} · {s.branch} · {facts.join(" · ")}
        </p>
        {picked && !progress && (
          <Input
            className="h-7 max-w-xs text-xs"
            placeholder={`Branch in the cloud: ${s.branch} (renamed if taken)`}
            value={branchAs}
            onChange={(e) => onBranchAs(e.target.value)}
            disabled={disabled}
          />
        )}
        {progress && (
          <p className="text-xs">
            <span className={progress.state === "failed" ? "text-destructive" : undefined}>
              {STATE_LABEL[progress.state]}
            </span>
            {progress.branch && progress.branch !== s.branch && ` as ${progress.branch}`}
            {progress.message && ` · ${progress.message}`}
            {progress.workspaceId && (
              <>
                {" · "}
                <Link className="underline" href={`/workspaces/${progress.workspaceId}`}>
                  Open
                </Link>
              </>
            )}
          </p>
        )}
      </div>
    </li>
  );
}
