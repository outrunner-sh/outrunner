"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InlineMessage } from "@/components/ui/notice";
import { requestJson } from "@/lib/http/request-json";
import type { MemoryView } from "@/lib/memory/routes";

function when(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Settings → Memory: every note agents kept, the user's own and (in a team
 * org) the org's, newest first, each with a button to delete it, and a
 * filter for a long list. There's no adding here: a note is an agent's.
 */
export function MemorySettings({ org, initial }: { org: { id: string; name: string }; initial: MemoryView[] }) {
  const [memories, setMemories] = useState(initial);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      const answer = await requestJson<{ memories: MemoryView[] }>(`/api/memory/${id}?org=${encodeURIComponent(org.id)}`, {
        method: "DELETE",
        has: (d) => Array.isArray(d.memories),
        fallback: "Couldn't delete that note. Try again.",
      });
      setMemories(answer.memories);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete that note.");
    } finally {
      setBusy(false);
    }
  }

  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = memories.filter((m) => words.every((w) => m.body.toLowerCase().includes(w)));
  const own = shown.filter((m) => m.scope === "personal");
  const shared = shown.filter((m) => m.scope === "org");

  return (
    <div className="space-y-8">
      {error && <InlineMessage>{error}</InlineMessage>}
      {memories.length > 10 && <Input aria-label="Filter notes" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter notes" />}
      <NoteList title="Your memory" intro="Only your sessions see these, and every new one loads the newest." notes={own} busy={busy} onDelete={remove} />
      <NoteList
        title={`${org.name}'s memory`}
        intro="Shared with everyone in the org: agents read these when they look, and no session loads them on its own. Its writer or an admin can delete a note."
        notes={shared}
        busy={busy}
        onDelete={remove}
      />
    </div>
  );
}

function NoteList({
  title,
  intro,
  notes,
  busy,
  onDelete,
}: {
  title: string;
  intro: string;
  notes: MemoryView[];
  busy: boolean;
  onDelete(id: string): Promise<void>;
}) {
  return (
    <div className="space-y-3 border-t border-border/60 pt-6">
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      <p className="text-sm text-muted-foreground">{intro}</p>
      {notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notes.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {notes.map((note) => (
            <li key={note.id} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0 space-y-0.5">
                <p className="whitespace-pre-wrap text-sm text-foreground">{note.body}</p>
                <p className="text-xs text-muted-foreground">
                  {when(note.createdAt)}
                  {note.workspaceId && (
                    <>
                      {" · "}
                      <Link href={`/workspaces/${note.workspaceId}`} className="underline underline-offset-2 hover:text-foreground">
                        from a session
                      </Link>
                    </>
                  )}
                </p>
              </div>
              {note.canDelete && (
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void onDelete(note.id)}>
                  Delete
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
