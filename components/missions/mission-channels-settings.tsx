"use client";

/**
 * Settings → Org → Integrations → Slack, "Missions on call" (docs/missions.md,
 * "Bound channels in Settings"): each channel a Mission of the org is on call
 * in, that the viewer can see, with Disconnect for those with write on its
 * project.
 */

import Link from "next/link";
import { Unplug } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { BoundChannelView } from "@/lib/missions/mission-channels-list";
import { ON_CALL_STATE_LABEL, onCallTooltip, type OnCallState } from "@/lib/missions/on-call-state";
import { cn } from "@/lib/utils";

const STATE_DOT: Record<OnCallState, string> = {
  on_call: "bg-emerald-500",
  paused: "bg-amber-500",
  idle_paused: "bg-amber-500",
  budget_paused: "bg-red-500",
};

export function MissionChannelsSettings({ orgId }: { orgId: string }) {
  const [channels, setChannels] = useState<BoundChannelView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Bumped to look again, after a Disconnect.
  const [look, setLook] = useState(0);

  useEffect(() => {
    let live = true;
    fetch(`/api/orgs/${orgId}/mission-channels`, { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<{ channels: BoundChannelView[] }>) : Promise.reject(new Error(String(response.status)))))
      .then(
        (answer) => {
          if (!live) return;
          setChannels(answer.channels);
          setFailed(false);
        },
        () => {
          if (live) setFailed(true);
        },
      );
    return () => {
      live = false;
    };
  }, [orgId, look]);

  const disconnect = async (missionId: string) => {
    setBusy(missionId);
    setError(null);
    try {
      const response = await fetch(`/api/orgs/${orgId}/mission-channels/${missionId}`, { method: "DELETE" });
      if (!response.ok) {
        const answer = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(answer?.error ?? "That didn't go through. Try again.");
      }
    } catch {
      setError("Couldn't reach Outrunner. Try again.");
    }
    setBusy(null);
    setLook((n) => n + 1);
  };

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-foreground">Missions on call</h2>
      <p className="text-xs text-muted-foreground">
        Channels a Mission is on call in. Disconnect needs write on its project.
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {channels === null ? (
        <p className="text-xs text-muted-foreground">{failed ? "Couldn't load them. Reload the page to try again." : "Loading…"}</p>
      ) : channels.length === 0 ? (
        <p className="text-xs text-muted-foreground">None yet.</p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-md border border-border/60">
          {channels.map((c) => (
            <li key={c.missionId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <div className="min-w-0 space-y-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <a
                    href={`https://app.slack.com/client/${c.teamId}/${c.channelId}`}
                    target="_blank"
                    rel="noreferrer"
                    className={cn("truncate underline-offset-4 hover:underline", !c.channelName && "font-mono text-xs")}
                  >
                    #{c.channelName ?? c.channelId}
                  </a>
                  <span className="truncate text-xs text-muted-foreground">{c.teamName ?? c.teamId}</span>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                  <Link href={`/workspaces/${c.missionId}`} className="truncate text-foreground/90 underline-offset-4 hover:underline">
                    {c.missionTitle}
                  </Link>
                  <span>·</span>
                  <span className="truncate">{c.project}</span>
                  <span>·</span>
                  <span>
                    Bound by {c.boundBy ?? "someone"} on {new Date(c.boundAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title={onCallTooltip(c.state, c.facts)}>
                  <span className={cn("size-1.5 rounded-full", STATE_DOT[c.state])} />
                  {ON_CALL_STATE_LABEL[c.state]}
                </span>
                {c.canDisconnect && (
                  <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void disconnect(c.missionId)}>
                    <Unplug />
                    {busy === c.missionId ? "Disconnecting…" : "Disconnect"}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
