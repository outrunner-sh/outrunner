"use client";

import { useEffect, useMemo, useState } from "react";
import { Lock, Search } from "lucide-react";

import { ChecklistRow } from "@/components/onboarding/checklist-row";
import { ConnectClaudeRow } from "@/components/onboarding/connect-claude-row";
import type { OnboardingEnv, OnboardingRepo } from "@/lib/onboarding/types";

export type CloudModel = "claude" | "neev" | null;

/**
 * Everything a cloud session needs: Claude connected (or, where the server runs
 * Outrunner's own models, Skip: sessions start on those) and the GitHub
 * repository it works in.
 */
export function CloudSetup({
  env,
  model,
  onModel,
  repoId,
  onRepoId,
  onReady,
}: {
  env: OnboardingEnv;
  model: CloudModel;
  onModel: (model: CloudModel) => void;
  /** The one repository the session works in. */
  repoId: string | null;
  onRepoId: (id: string) => void;
  onReady: (ready: boolean) => void;
}) {
  // Null until the stored connection has been checked.
  const [checked, setChecked] = useState(false);
  const [repos, setRepos] = useState<OnboardingRepo[] | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    void env.claudeConnected().then((connected) => {
      if (!live) return;
      if (connected) onModel("claude");
      setChecked(true);
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

  const ready = model !== null && repoId !== null;
  useEffect(() => onReady(ready), [ready, onReady]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (repos ?? []).filter((r) => !q || r.fullName.toLowerCase().includes(q));
  }, [repos, query]);

  const chosen = repos?.find((r) => r.id === repoId);

  return (
    <div className="border-border/60 bg-card/30 overflow-hidden rounded-xl border">
      <ConnectClaudeRow
        env={env}
        connected={model === "claude" ? true : checked ? false : null}
        onConnected={() => onModel("claude")}
        {...(env.outrunnerModels && {
          todo: "Use your Claude Pro or Max subscription, or skip: sessions then start on Outrunner's model.",
          skipped:
            model === "neev"
              ? "Skipped. Sessions start on Outrunner's model. Connect Claude anytime in Settings."
              : undefined,
          onSkip: () => onModel("neev"),
        })}
      />

      <ChecklistRow
        state={repos === null ? "working" : repoError ? "problem" : repoId !== null ? "done" : "todo"}
        title="Choose a repository"
        detail={
          repos === null
            ? "Loading the repositories your GitHub account can reach…"
            : repoError
              ? repoError
              : repos.length === 0
              ? "No repositories found on your GitHub account."
              : chosen
                ? `${chosen.fullName}. You can add more later.`
                : "Pick the one your first session works in. You can add more later."
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
              {shown.map((repo) => {
                const checked = repo.id === repoId;
                return (
                  <li key={repo.id} className="border-border/40 border-b last:border-b-0">
                    <label className="hover:bg-accent/40 flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm">
                      <input
                        type="radio"
                        name="onboarding-repository"
                        checked={checked}
                        onChange={() => onRepoId(repo.id)}
                        className="accent-foreground size-3.5"
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{repo.fullName}</span>
                      {repo.private && <Lock className="text-muted-foreground size-3" aria-label="Private" />}
                    </label>
                  </li>
                );
              })}
              {shown.length === 0 && (
                <li className="text-muted-foreground px-3 py-3 text-xs">No repository matches “{query}”.</li>
              )}
            </ul>
          </div>
        )}
      </ChecklistRow>
    </div>
  );
}
