"use client";

import { useEffect, useState } from "react";

import { Row, Switch } from "@/components/notification-settings";
import { SectionHeader } from "@/components/settings-details";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/loaders";
import { requestJson } from "@/lib/http/request-json";

type Saved = { projectId: string; project: string; savedAt: string; expiresAt: string; sites: string[] | null };
type Settings = { available: boolean; keep: boolean; saved: Saved[] };

const ROUTE = "/api/settings/browser-sign-ins";

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Settings → Sandbox → Desktop browser: whether the cloud desktop's browser
 * keeps its sign-ins from one of the person's sessions to their next on the
 * same repository (a project, lib/browser-sign-ins/sign-ins.ts), and the
 * repositories it keeps them for, each with the sites and a way to forget
 * them. Turning it off forgets them all.
 */
export function BrowserSignInSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    requestJson<Settings>(ROUTE, { fallback: "Couldn't load your browser sign-ins." })
      .then(setSettings)
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : "Couldn't load them."));
  }, []);

  const run = async (change: () => Promise<Partial<Settings>>) => {
    setError(null);
    setBusy(true);
    try {
      const next = await change();
      setSettings((current) => (current ? { ...current, ...next } : current));
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : "Couldn't change that.");
    } finally {
      setBusy(false);
    }
  };

  const setKeep = (keep: boolean) => run(() => requestJson<Settings>(ROUTE, { method: "PUT", body: { keep } }));
  const forget = (projectId?: string) =>
    run(() => requestJson<{ saved: Saved[] }>(projectId ? `${ROUTE}?project=${encodeURIComponent(projectId)}` : ROUTE, { method: "DELETE" }));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <SectionHeader title="Desktop browser" />
        {busy && <Spinner label="Saving" className="size-3 text-muted-foreground" />}
      </div>
      {settings ? (
        <div className="divide-y divide-border/60 rounded-lg border border-border/60 text-[13px]">
          <Row
            title="Keep sign-ins between sessions"
            detail={
              !settings.available
                ? "Not available on this deployment yet."
                : settings.keep
                  ? "What you sign in to in a session's desktop browser is there in your next session on the same repository, for you alone, encrypted, and forgotten 30 days after it was last used. The agent in those sessions uses that browser too."
                  : "Every session's desktop browser starts signed out."
            }
            control={
              <Switch
                on={settings.keep}
                label="Keep sign-ins between sessions"
                disabled={busy || !settings.available}
                onChange={(on) => void setKeep(on)}
              />
            }
          />
          {settings.saved.map((saved) => (
            <Row
              key={saved.projectId}
              title={saved.project}
              detail={`${saved.sites ? saved.sites.join(", ") : "Can't be read any more"} · saved ${day(saved.savedAt)}, kept until ${day(saved.expiresAt)}`}
              control={
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void forget(saved.projectId)}>
                  Forget
                </Button>
              }
            />
          ))}
          {settings.saved.length > 1 && (
            <Row
              title="All repositories"
              control={
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void forget()}>
                  Forget all
                </Button>
              }
            />
          )}
        </div>
      ) : (
        !error && <Spinner label="Loading browser sign-ins" />
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
