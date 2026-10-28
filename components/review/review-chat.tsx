"use client";

import { ArrowUp, Send } from "lucide-react";
import { useRef, useState } from "react";

import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Message = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = ["What could break if this merges?", "Walk me through the main code path.", "Is anything here untested?"];

/**
 * "Ask about this PR": a conversation answered from the PR's code, on the
 * org's model budget; and, for the person whose session opened it, a way to
 * send what needs changing to that session.
 */
export function ReviewChat({ repo, number, canSend }: { repo: string; number: number; canSend: boolean }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setDraft("");
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/review/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, number, messages: next }),
      });
      const body = (await response.json().catch(() => ({}))) as { answer?: string; error?: string };
      setMessages([...next, { role: "assistant", content: body.answer ?? body.error ?? "Couldn't answer that." }]);
    } finally {
      setBusy(false);
      setTimeout(() => end.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/review/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, number, message: text }),
      });
      const body = (await response.json().catch(() => ({}))) as { sessionId?: string; error?: string };
      if (response.ok && body.sessionId) {
        setDraft("");
        setNote("Sent to its session. It pushes to this PR when it's done.");
      } else {
        setNote(body.error ?? "Couldn't send it.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-border/60">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="text-[13px] text-muted-foreground">Ask anything about this PR. The agent reads the diff and the code, and answers from them.</p>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="ml-6 rounded-lg bg-muted px-3 py-2 text-[13px]">
              {m.content}
            </div>
          ) : (
            <div key={i} className="text-[13px]">
              <Markdown>{m.content}</Markdown>
            </div>
          ),
        )}
        {busy && <p className="text-[12px] text-muted-foreground">Reading the change…</p>}
        <div ref={end} />
      </div>
      <div className="space-y-2 border-t border-border/60 p-3">
        {messages.length === 0 && (
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => ask(s)}
                className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask(draft);
            }
          }}
          placeholder="Ask about this PR"
          className="min-h-16 text-[13px]"
          disabled={busy}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">{note}</span>
          <span className="flex gap-1.5">
            {canSend && (
              <Button size="sm" variant="outline" onClick={send} disabled={busy || !draft.trim()} title="Send this to the session that opened the PR">
                <Send />
                Send to session
              </Button>
            )}
            <Button size="sm" onClick={() => ask(draft)} disabled={busy || !draft.trim()} aria-label="Ask">
              <ArrowUp />
            </Button>
          </span>
        </div>
      </div>
    </aside>
  );
}
