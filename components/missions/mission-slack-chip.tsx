"use client";

/**
 * A Mission's Slack channel in its header (docs/missions.md, "On call in
 * Slack"): the channel it's on call in, with pause/resume and disconnect
 * (paused by a person, or idle-paused: no one replied for 2 weeks);
 * or, when it's in none, Connect Slack channel, picking one Outrunner is in.
 * Changing it needs write on the Mission's project; without it, the chip
 * only shows.
 */

import { Pause, Play, Unplug } from "lucide-react";
import { useEffect, useState } from "react";

import { SlackIcon } from "@/components/brand-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MissionSlackView } from "@/lib/missions/slack-text";
import { cn } from "@/lib/utils";

async function send(missionId: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<string | null> {
  try {
    const response = await fetch(`/api/missions/${missionId}/slack`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (response.ok) return null;
    const answer = (await response.json().catch(() => null)) as { error?: string } | null;
    return answer?.error ?? "That didn't go through. Try again.";
  } catch {
    return "Couldn't reach Outrunner. Try again.";
  }
}

export function MissionSlackChip({ missionId, onError }: { missionId: string; onError: (why: string | null) => void }) {
  const [view, setView] = useState<MissionSlackView | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped to look again: after a change, or as the picker opens (which
  // asks for the channels too: Slack is asked only then).
  const [look, setLook] = useState({ n: 0, channels: false });
  const load = (channels = false) => setLook((l) => ({ n: l.n + 1, channels }));

  useEffect(() => {
    let live = true;
    fetch(`/api/missions/${missionId}/slack${look.channels ? "?channels=1" : ""}`, { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<MissionSlackView>) : null))
      .then((answer) => {
        if (live && answer) setView(answer);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [missionId, look]);

  const act = async (method: "POST" | "PATCH" | "DELETE", body?: unknown) => {
    setBusy(true);
    onError(await send(missionId, method, body));
    setBusy(false);
    load();
  };

  if (!view) return null;
  const chip =
    "hidden shrink-0 items-center gap-1 rounded-md border border-white/[0.08] px-1.5 py-0.5 text-[12px] text-[#a3a3a3] outline-none transition-colors hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-white/30 md:inline-flex";
  const binding = view.binding;
  if (binding) {
    const label = `#${binding.channelName ?? binding.channelId}`;
    const idle = binding.paused && binding.idlePaused === true;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(chip, binding.paused && "text-[#8f8f8f]")}
          aria-label={`On call in Slack ${label}${idle ? ", idle-paused" : binding.paused ? ", paused" : ""}`}
          title={
            idle
              ? `Idle-paused in ${label}: no one replied for 2 weeks, so it takes nothing from Slack`
              : binding.paused
                ? `Paused in ${label}: it takes nothing from Slack`
                : `On call in ${label}: mentions there reach this Mission`
          }
          disabled={busy}
        >
          <SlackIcon className="size-3" />
          <span className="max-w-[140px] truncate">{label}</span>
          {binding.paused && <span className="text-[11px] text-[#d29922]">{idle ? "idle-paused" : "paused"}</span>}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[240px]">
          <DropdownMenuLabel className="text-[11.5px] font-normal text-muted-foreground">
            {idle
              ? `Idle-paused in ${label}: no one replied for 2 weeks. Resume, or @Outrunner resume there, to continue.`
              : `On call in ${label}. Mentions there, and replies in its threads, reach this Mission.`}
          </DropdownMenuLabel>
          {view.canManage && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void act("PATCH", { paused: !binding.paused })}>
                {binding.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                {binding.paused ? "Resume" : "Pause"}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void act("DELETE")}>
                <Unplug className="size-3.5" />
                Disconnect channel
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  if (!view.canManage) return null;
  return (
    <DropdownMenu onOpenChange={(open) => open && load(true)}>
      <DropdownMenuTrigger className={cn(chip, "text-[#8f8f8f]")} disabled={busy} title="Put this Mission on call in a Slack channel">
        <SlackIcon className="size-3" />
        Connect Slack channel
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[320px] w-[260px] overflow-y-auto">
        <DropdownMenuLabel className="text-[11.5px] font-normal text-muted-foreground">
          {look.channels && view.channels.length === 0 && !view.hint
            ? "Looking for channels Outrunner is in…"
            : (view.hint ?? "Put this Mission on call in a channel Outrunner is in. Or, in Slack: @Outrunner be on call here for <project>.")}
        </DropdownMenuLabel>
        {view.channels.length > 0 && <DropdownMenuSeparator />}
        {view.channels.map((c) => (
          <DropdownMenuItem key={`${c.teamId}:${c.id}`} onSelect={() => void act("POST", { teamId: c.teamId, channelId: c.id })}>
            <span className="truncate">#{c.name}</span>
            {c.teamName && <span className="ml-auto truncate text-[11px] text-muted-foreground">{c.teamName}</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
