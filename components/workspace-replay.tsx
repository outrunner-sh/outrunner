"use client";

import "@xterm/xterm/css/xterm.css";

import { FileDiff, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ConversationTimeline } from "@/components/conversation-timeline";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/loaders";
import { SkeletonRows, SkeletonSwap } from "@/components/ui/skeleton-swap";
import { useCastPlayer } from "@/hooks/use-cast-player";
import type { AgentEvent, WorkspaceSummary } from "@/lib/runtime/agent-protocol";
import type { Cast } from "@/lib/runtime/replay/cast";
import type { SnapshotManifest } from "@/lib/runtime/snapshot/manifest";
import type { WorkspaceSnapshot } from "@/lib/runtime/snapshot/types";
import { AGENTS } from "@/lib/agents/registry";
import { MAIN_CHAT, MAIN_CHAT_NAME } from "@/lib/session/chats";

type ReplayData = {
  snapshotId: string;
  manifest: SnapshotManifest;
  cast: Cast | null;
  events: AgentEvent[];
  patch: string;
  summary: WorkspaceSummary | null;
};

/**
 * Read-only Replay of an archived Workspace Session. Every projection — terminal
 * cast, conversation, diff — is reconstructed from the Snapshot in storage; no
 * Runtime Computer is involved (M4 invariant #2), so this works even after the
 * box is gone.
 */
export function WorkspaceReplay({
  workspaceId,
  snapshots,
}: {
  workspaceId: string;
  snapshots: WorkspaceSnapshot[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    snapshots[0]?.id ?? null,
  );
  // The chat whose conversation shows: the main one unless another of the
  // Snapshot's is picked.
  const [chatId, setChatId] = useState<string>(MAIN_CHAT);
  const [data, setData] = useState<ReplayData | null>(null);
  // From the row's copy of the manifest, so the picker stays put while a
  // chat's conversation loads.
  const snapshotChats = snapshots.find((s) => s.id === selectedId)?.manifest.chats ?? [];
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    const load = async () => {
      // Drop the previous Snapshot's artifacts immediately so a slow fetch never
      // pairs stale cast/conversation/diff with the newly-selected label.
      setData(null);
      setLoading(true);
      setError(null);
      try {
        const chat = chatId === MAIN_CHAT ? "" : `&chat=${encodeURIComponent(chatId)}`;
        const res = await fetch(
          `/api/workspaces/${workspaceId}/replay?snapshotId=${selectedId}${chat}`,
        );
        const body = (await res.json()) as ReplayData & { error?: string };
        if (!active) return;
        if (!res.ok) {
          setError(body.error ?? "Could not load this Snapshot.");
          setData(null);
        } else {
          setData(body);
        }
      } catch {
        if (active) setError("Could not load this Snapshot.");
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [workspaceId, selectedId, chatId]);

  if (snapshots.length === 0) {
    return (
      <p className="text-muted-foreground p-6 text-sm">
        This workspace has no Snapshots yet. Archive it to capture one.
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <div className="flex items-center gap-3">
        <label className="text-muted-foreground text-xs" htmlFor="snapshot">
          Snapshot
        </label>
        <select
          id="snapshot"
          className="h-7 rounded-md border border-white/10 bg-transparent px-2 text-xs text-foreground"
          value={selectedId ?? ""}
          onChange={(e) => {
            // Another Snapshot may not hold the chat shown.
            setChatId(MAIN_CHAT);
            setSelectedId(e.target.value);
          }}
        >
          {snapshots.map((s) => (
            <option key={s.id} value={s.id}>
              {new Date(s.archivedAt).toLocaleString()}
            </option>
          ))}
        </select>
        {snapshotChats.length > 0 && (
          <>
            <label className="text-muted-foreground text-xs" htmlFor="replay-chat">
              Chat
            </label>
            <select
              id="replay-chat"
              className="h-7 rounded-md border border-white/10 bg-transparent px-2 text-xs text-foreground"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
            >
              <option value={MAIN_CHAT}>{MAIN_CHAT_NAME}</option>
              {snapshotChats.map((chat) => (
                <option key={chat.id} value={chat.id}>
                  {chat.name} · {AGENTS[chat.agent].label}
                </option>
              ))}
            </select>
          </>
        )}
        {loading && <Spinner className="text-muted-foreground size-4" />}
      </div>

      {error && (
        <p aria-live="polite" className="text-destructive text-xs">
          {error}
        </p>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
        <CastPanel cast={data?.cast ?? null} imported={data?.manifest.origin !== undefined} />
        <div className="replay-panel">
          <div className="replay-panel-head">Conversation</div>
          <SkeletonSwap
            ready={data !== null || error !== null}
            skeleton={<SkeletonRows rows={6} rowHeight={28} indent={16} className="pt-4" />}
            label="Conversation"
            className="min-h-0 flex-1"
          >
            <div className="flex h-full min-h-0 flex-col">
              <ConversationTimeline events={data?.events ?? []} />
            </div>
          </SkeletonSwap>
        </div>
      </div>

      <DiffPanel patch={data?.patch ?? null} summary={data?.summary ?? null} failed={error !== null} />
    </div>
  );
}

function CastPanel({ cast, imported }: { cast: Cast | null; imported: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const player = useCastPlayer(cast, containerRef);

  return (
    <div className="replay-panel">
      <div className="replay-panel-head">
        <span>Terminal</span>
        <Button
          disabled={player.status === "empty"}
          onClick={player.toggle}
          size="sm"
          variant="outline"
        >
          {player.status === "playing" ? <Pause /> : <Play />}
          {player.status === "playing" ? "Pause" : "Play"}
        </Button>
        <input
          aria-label="Seek"
          className="flex-1"
          type="range"
          min={0}
          max={Math.max(player.duration, 0.001)}
          step={0.05}
          value={player.currentTime}
          onChange={(e) => player.seek(Number(e.target.value))}
        />
        <span className="text-muted-foreground w-24 text-right font-mono text-[11px]">
          {formatTime(player.currentTime)} / {formatTime(player.duration)}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-black p-2">
        {imported && !cast ? (
          <p className="text-muted-foreground p-2 text-xs">
            No terminal recording: this session was imported from a Mac.
          </p>
        ) : null}
        <div ref={containerRef} />
      </div>
    </div>
  );
}

/** The Snapshot's uncommitted diff. Null `patch` while it loads: "no changes"
 *  is only said once the Snapshot has actually been read. */
function DiffPanel({
  patch,
  summary,
  failed,
}: {
  patch: string | null;
  summary: WorkspaceSummary | null;
  failed: boolean;
}) {
  return (
    <div className="replay-panel max-h-64">
      <div className="replay-panel-head">
        <FileDiff className="size-4" /> Changes
        {summary && (
          <span className="text-muted-foreground font-normal">
            {summary.changedFiles} changed · {summary.commitCount} commit
            {summary.commitCount === 1 ? "" : "s"} · {summary.filesTouched.length} touched
          </span>
        )}
      </div>
      <SkeletonSwap
        ready={patch !== null || failed}
        skeleton={<SkeletonRows rows={4} rowHeight={20} indent={12} className="pt-3" />}
        label="Changes"
        className="min-h-0 flex-1"
      >
        <pre className="h-full overflow-auto bg-black p-3 font-mono text-[11px] leading-relaxed text-foreground/80">
          {patch === null ? "" : patch.trim() === "" ? "No uncommitted changes captured." : patch}
        </pre>
      </SkeletonSwap>
    </div>
  );
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
