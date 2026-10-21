"use client";

import { useEffect, useMemo, useState } from "react";
import { Lock, Search } from "lucide-react";

import { ChecklistRow } from "@/components/onboarding/checklist-row";
import { ConnectClaudeRow } from "@/components/onboarding/connect-claude-row";
import { Button } from "@/components/ui/button";
import { type CloudModel, claudeOffer, startingCloudModel } from "@/lib/onboarding/claude-choice";
import { type ImportFound, importFoundText } from "@/lib/onboarding/import-offer";
import type { OnboardingEnv, OnboardingRepo } from "@/lib/onboarding/types";

/**
 * Setting up the cloud: the GitHub repositories to work in, and, for a user
 * who has them, Claude (lib/onboarding/claude-choice.ts) and work on this Mac
 * to import (lib/onboarding/import-offer.ts). Starting a session is the flow's
 * choice, not a step: a user can finish here and start one later.
 */
export function CloudSetup({
  env,
  model,
  onModel,
  picked,
  onPicked,
  onReady,
  onImport,
  busy,
}: {
  env: OnboardingEnv;
  model: CloudModel;
  onModel: (model: CloudModel) => void;
  /** The repositories picked, in the order they were picked. */
  picked: OnboardingRepo[];
  onPicked: (repos: OnboardingRepo[]) => void;
  /** Whether onboarding can finish: repositories picked, or none to pick. */
  onReady: (ready: boolean) => void;
  /** Finish, and go on to import this Mac's work. */
  onImport: () => void;
  /** Finishing is under way: no other way out meanwhile. */
  busy: boolean;
}) {
  // Each null until checked.
  const [connected, setConnected] = useState<boolean | null>(null);
  const [onMac, setOnMac] = useState<boolean | null>(null);
  const [imports, setImports] = useState<ImportFound | null>(null);
  const [repos, setRepos] = useState<OnboardingRepo[] | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    const { outrunnerModels } = env;
    void env.claudeConnected().then((found) => {
      if (!live) return;
      setConnected(found);
      onModel(startingCloudModel({ connected: found, outrunnerModels }));
    });
    void env.claudeOnMac().then((found) => {
      if (live) setOnMac(found);
    });
    void env.findImports().then((found) => {
      if (live) setImports(found);
    });
    env.listRepos().then(
      (list) => {
        if (live) setRepos(list);
      },
      (error: unknown) => {
        if (!live) return;
        setRepoError(error instanceof Error ? error.message : String(error));
        setRepos([]);
      },
    );
    return () => {
      live = false;
    };
  }, [env, onModel]);

  const offer = claudeOffer({ connected, onMac, outrunnerModels: env.outrunnerModels });
  // With no repository to pick (none on GitHub, or GitHub unreachable), the
  // user can still finish and add them later.
  const ready = repos !== null && (picked.length > 0 || repos.length === 0);
  useEffect(() => onReady(ready), [ready, onReady]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (repos ?? []).filter((r) => !q || r.fullName.toLowerCase().includes(q));
  }, [repos, query]);

  const isPicked = (repo: OnboardingRepo) => picked.some((p) => p.id === repo.id);
  const toggle = (repo: OnboardingRepo) =>
    onPicked(isPicked(repo) ? picked.filter((p) => p.id !== repo.id) : [...picked, repo]);

  return (
    <div className="border-border/60 bg-card/30 overflow-hidden rounded-xl border">
      <ChecklistRow
        state={repos === null ? "working" : repoError ? "problem" : picked.length > 0 ? "done" : "todo"}
        title="Add your repositories"
        detail={
          repos === null
            ? "Loading the repositories your GitHub account can reach…"
            : repoError
              ? `${repoError} You can add repositories later.`
              : repos.length === 0
                ? "No repositories found on your GitHub account. You can add them later."
                : picked.length > 0
                  ? `${picked.length} picked. You can add more later.`
                  : "Pick the ones you want agents to work in. You can add more later."
        }
      >
        {repos !== null && repos.length > 0 && (
          <div className="space-y-2">
            {repos.length > 6 && (
              <label className="border-border/60 bg-background/60 flex items-center gap-2 rounded-md border px-2.5">
                <Search className="text-muted-foreground size-3.5" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search repositories"
                  className="h-8 flex-1 bg-transparent text-sm outline-none"
                />
              </label>
            )}
            <ul className="border-border/60 max-h-56 overflow-y-auto rounded-md border">
              {shown.map((repo) => (
                <li key={repo.id} className="border-border/40 border-b last:border-b-0">
                  <label className="hover:bg-accent/40 flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={isPicked(repo)}
                      onChange={() => toggle(repo)}
                      disabled={busy}
                      className="accent-foreground size-3.5"
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{repo.fullName}</span>
                    {repo.private && <Lock className="text-muted-foreground size-3" aria-label="Private" />}
                  </label>
                </li>
              ))}
              {shown.length === 0 && (
                <li className="text-muted-foreground px-3 py-3 text-xs">No repository matches “{query}”.</li>
              )}
            </ul>
          </div>
        )}
      </ChecklistRow>

      {/* Below the repositories: each of these is found a moment later, and
          a row appearing here moves nothing the user is reading. */}
      {offer !== "hidden" && (
        <ConnectClaudeRow
          env={env}
          connected={model === "claude" ? true : connected === null ? null : false}
          onConnected={() => onModel("claude")}
          optional={offer === "optional"}
          todo={
            offer === "optional"
              ? "Optional. Sessions start on Outrunner's models; connect to use your Claude Pro or Max subscription instead."
              : "Needed to start sessions: this server has no models of its own. Use your Claude Pro or Max subscription."
          }
        />
      )}

      {imports && (
        <ChecklistRow
          state="todo"
          title="Import from this Mac"
          detail={`${importFoundText(imports)} Bring them to the cloud, with their repositories' environments and your agent setup.`}
          action={
            <Button size="sm" variant="outline" disabled={busy} onClick={onImport}>
              Import
            </Button>
          }
        />
      )}
    </div>
  );
}
