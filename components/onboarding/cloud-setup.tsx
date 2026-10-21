"use client";

import { useEffect, useMemo, useState } from "react";
import { Lock, Search } from "lucide-react";

import { ChecklistRow } from "@/components/onboarding/checklist-row";
import { ConnectClaudeRow } from "@/components/onboarding/connect-claude-row";
import { type CloudModel, claudeOffer, startingCloudModel } from "@/lib/onboarding/claude-choice";
import type { OnboardingEnv, OnboardingRepo } from "@/lib/onboarding/types";

/**
 * Everything a cloud session needs: the GitHub repository it works in, and a
 * model to run. That's Outrunner's own unless the user has Claude: one already
 * connected is used, and one logged in to Claude Code on this Mac is offered.
 * Where the server has no models of its own, Claude is a must
 * (lib/onboarding/claude-choice.ts).
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
  // Each null until checked.
  const [connected, setConnected] = useState<boolean | null>(null);
  const [onMac, setOnMac] = useState<boolean | null>(null);
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
  const ready = model !== null && repoId !== null;
  useEffect(() => onReady(ready), [ready, onReady]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (repos ?? []).filter((r) => !q || r.fullName.toLowerCase().includes(q));
  }, [repos, query]);

  const chosen = repos?.find((r) => r.id === repoId);

  return (
    <div className="border-border/60 bg-card/30 overflow-hidden rounded-xl border">
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

      {/* Below the repositories: on the Mac its check can land a moment
          later, and a row appearing here moves nothing the user is reading. */}
      {offer !== "hidden" && (
        <ConnectClaudeRow
          env={env}
          connected={model === "claude" ? true : connected === null ? null : false}
          onConnected={() => onModel("claude")}
          {...(offer === "optional" && {
            optional: "Optional. Sessions start on Outrunner's models; connect to use your Claude Pro or Max subscription instead.",
          })}
        />
      )}
    </div>
  );
}
