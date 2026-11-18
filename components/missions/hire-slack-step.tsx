"use client";

/**
 * Hire's last step: put the new Mission on call in a Slack channel
 * (docs/missions.md, "On call in Slack"). The header's Connect Slack channel
 * as a list, through the same route; later, the header does it.
 */

import { Check } from "lucide-react";
import { useEffect, useState } from "react";

import { SlackIcon } from "@/components/brand-icons";
import { Spinner } from "@/components/ui/loaders";
import type { MissionSlackView } from "@/lib/missions/slack-text";
import { cn } from "@/lib/utils";

export function HireSlackStep({ missionId, suggested }: { missionId: string; suggested: boolean }) {
  const [view, setView] = useState<MissionSlackView | null>(null);
  const [loading, setLoading] = useState(true);
  const [binding, setBinding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [look, setLook] = useState(0);

  useEffect(() => {
    let live = true;
    fetch(`/api/missions/${missionId}/slack?channels=1`, { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<MissionSlackView>) : null))
      .then((answer) => {
        if (live) setView(answer);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [missionId, look]);

  const bind = async (teamId: string, channelId: string) => {
    setBinding(channelId);
    setError(null);
    try {
      const response = await fetch(`/api/missions/${missionId}/slack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId, channelId }),
      });
      if (!response.ok) {
        const answer = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(answer?.error ?? "That didn't go through. Try again.");
      }
    } catch {
      setError("Couldn't reach Outrunner. Try again.");
    }
    setBinding(null);
    setLook((n) => n + 1);
  };

  const bound = view?.binding;
  return (
    <section
      aria-labelledby="hire-slack"
      className={cn("rounded-lg border px-3 py-2.5", suggested ? "border-white/20 bg-white/[0.03]" : "border-white/[0.08]")}
    >
      <h3 id="hire-slack" className="flex items-center gap-1.5 text-[13px] font-medium text-[#ededed]">
        <SlackIcon className="size-3.5" />
        {bound ? "On call in Slack" : suggested ? "Next: connect a Slack channel" : "Connect a Slack channel (optional)"}
      </h3>
      {loading ? (
        <p className="mt-1.5 flex items-center gap-2 text-[12.5px] text-[#8f8f8f]">
          <Spinner className="size-3" label="Looking" /> Looking for channels Outrunner is in…
        </p>
      ) : bound ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-[#a3a3a3]">
          <Check className="size-3.5 text-[#56d364]" />
          Mentions in #{bound.channelName ?? bound.channelId} reach this Mission.
        </p>
      ) : !view?.canManage ? (
        <p className="mt-1.5 text-[12.5px] text-[#8f8f8f]">Connect a channel later from the Mission&apos;s header.</p>
      ) : (
        <>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[#8f8f8f]">
            {view.channels.length === 0
              ? (view.hint ?? "Outrunner isn't in a channel yet. In Slack: @Outrunner be on call here for <repository>.")
              : "Mentions of @Outrunner there reach this Mission; it replies in the thread."}
          </p>
          {view.channels.length > 0 && (
            <ul className="mt-2 flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">
              {view.channels.map((c) => (
                <li key={`${c.teamId}:${c.id}`}>
                  <button
                    type="button"
                    disabled={binding !== null}
                    onClick={() => void bind(c.teamId, c.id)}
                    title={c.teamName ? `#${c.name} in ${c.teamName}` : `#${c.name}`}
                    className="inline-flex h-7 max-w-[200px] items-center gap-1.5 rounded-md border border-white/10 px-2.5 text-[12.5px] text-[#d6d6d6] transition-colors hover:border-white/25 hover:text-white disabled:opacity-50"
                  >
                    {binding === c.id && <Spinner className="size-3" label="Connecting" />}
                    <span className="truncate">#{c.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-[#ffa198]">
          {error}
        </p>
      )}
    </section>
  );
}
