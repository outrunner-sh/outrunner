"use client";

import { ArrowUp, Wand2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ChangeCard, type ChangeTrack } from "@/components/review/change-card";
import { dropQuote, usePickedQuote } from "@/components/review/quote-store";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { LineQuote } from "@/lib/review/change";
import { isImeKeydown } from "@/lib/session/composing";

type Message =
  | { role: "user" | "assistant"; content: string; quote?: LineQuote }
  | { role: "change"; content: string; quote?: LineQuote; track: ChangeTrack };

const SUGGESTIONS = ["What could break if this merges?", "Walk me through the main code path.", "Is anything here untested?"];

const quoteLabel = (q: LineQuote) =>
  `${q.path}:${q.startLine === q.endLine ? q.startLine : `${q.startLine}–${q.endLine}`}${q.side === "old" ? " (removed)" : ""}`;

/** A question about picked lines, as the model reads it: the lines quoted
 *  first. */
function withQuote(text: string, quote: LineQuote | undefined): string {
  if (!quote) return text;
  return `About \`${quoteLabel(quote)}\`:\n\`\`\`\n${quote.code.slice(0, 6000)}\n\`\`\`\n\n${text}`;
}

// The changes asked for are kept for the tab, so a reload still follows them.
const changesKey = (repo: string, number: number) => `outrunner:review-changes:${repo}#${number}`;

function keptChanges(repo: string, number: number): Message[] {
  try {
    const raw = sessionStorage.getItem(changesKey(repo, number));
    return raw ? (JSON.parse(raw) as Message[]).filter((m) => m.role === "change") : [];
  } catch {
    return [];
  }
}

function keepChanges(repo: string, number: number, messages: Message[]): void {
  try {
    sessionStorage.setItem(changesKey(repo, number), JSON.stringify(messages.filter((m) => m.role === "change").slice(-10)));
  } catch {
    // Storage blocked or full: the change is followed until the page closes.
  }
}

function QuoteChip({ quote, onDrop }: { quote: LineQuote; onDrop?: () => void }) {
  return (
    <div className="rounded-md border border-sky-500/30 bg-sky-500/5 text-[11px]">
      <div className="flex items-center justify-between gap-2 px-2 py-1 text-muted-foreground">
        <span className="truncate font-mono">{quoteLabel(quote)}</span>
        {onDrop && (
          <button type="button" onClick={onDrop} aria-label="Drop the quoted lines" className="hover:text-foreground">
            <X className="size-3" />
          </button>
        )}
      </div>
      <pre className="max-h-24 overflow-hidden border-t border-sky-500/20 px-2 py-1 font-mono text-[11px] whitespace-pre-wrap text-foreground/80">
        {quote.code}
      </pre>
    </div>
  );
}

/**
 * "Ask about this PR": a conversation answered from the PR's code, on the
 * org's model budget. And "Ask for a change": what should change, sent to
 * the PR's session (or a new one on its branch), which makes it and pushes
 * to the PR; the chat follows it to its commit. Lines picked in the diff are
 * quoted into either.
 */
export function ReviewChat({ repo, number, canChange }: { repo: string; number: number; canChange: boolean }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"ask" | "change" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [quote, setQuote] = useState<LineQuote | null>(null);
  const [intent, setIntent] = useState<"ask" | "change">("ask");
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // Changes asked for before a reload, still followed.
  useEffect(() => {
    const kept = keptChanges(repo, number);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage is only readable after mount
    if (kept.length) setMessages(kept);
  }, [repo, number]);

  // Lines picked in the diff come here, ready to ask about or to change.
  const picked = usePickedQuote(`${repo}#${number}`);
  useEffect(() => {
    if (!picked) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a pick is an event from the diff, taken in as it comes
    setQuote(picked.quote);
    setIntent(picked.intent === "change" && canChange ? "change" : "ask");
    input.current?.focus();
  }, [picked, canChange]);

  const scrollDown = () => setTimeout(() => end.current?.scrollIntoView({ behavior: "smooth" }), 50);
  const clearQuote = () => {
    setQuote(null);
    setIntent("ask");
    dropQuote();
  };

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    const asked = { role: "user" as const, content: text, quote: quote ?? undefined };
    const next = [...messages, asked];
    setMessages(next);
    setDraft("");
    clearQuote();
    setBusy("ask");
    setNote(null);
    try {
      const conversation = next
        .filter((m): m is Extract<Message, { role: "user" | "assistant" }> => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.role === "user" ? withQuote(m.content, m.quote) : m.content }));
      const response = await fetch("/api/review/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, number, messages: conversation }),
      });
      const body = (await response.json().catch(() => ({}))) as { answer?: string; error?: string };
      setMessages((current) => [...current, { role: "assistant", content: body.answer ?? body.error ?? "Couldn't answer that." }]);
    } finally {
      setBusy(null);
      scrollDown();
    }
  };

  const requestChange = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy("change");
    setNote(null);
    try {
      const response = await fetch("/api/review/change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, number, message: text, quote }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        kind?: "sent" | "started";
        sessionId?: string;
        own?: boolean;
        threads?: number;
        since?: string;
        askedAt?: string;
        error?: string;
      };
      if (!response.ok || !body.sessionId || !body.kind || !body.since) {
        setNote(body.error ?? "Couldn't ask for the change.");
        return;
      }
      const track: ChangeTrack = {
        sessionId: body.sessionId,
        kind: body.kind,
        own: body.own === true,
        since: body.since,
        threads: body.threads ?? 0,
        askedAt: body.askedAt ?? new Date().toISOString(),
      };
      setMessages((current) => {
        const next = [...current, { role: "change" as const, content: text, quote: quote ?? undefined, track }];
        keepChanges(repo, number, next);
        return next;
      });
      setDraft("");
      clearQuote();
      scrollDown();
    } finally {
      setBusy(null);
    }
  };

  const primary = intent === "change" && canChange ? requestChange : () => ask(draft);

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-border/60">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="text-[13px] text-muted-foreground">
            Ask anything about this PR, or ask for a change. Pick lines in the diff to quote them. The agent reads the
            diff and the code; a change goes to the PR&apos;s session, which pushes it here.
          </p>
        )}
        {messages.map((m, i) =>
          m.role === "assistant" ? (
            <div key={i} className="text-[13px]">
              <Markdown>{m.content}</Markdown>
            </div>
          ) : (
            <div key={i} className="ml-6 space-y-1.5">
              {m.quote && <QuoteChip quote={m.quote} />}
              <div className="rounded-lg bg-muted px-3 py-2 text-[13px]">
                {m.role === "change" && <Wand2 className="mr-1.5 inline size-3.5 text-muted-foreground" />}
                {m.content}
              </div>
              {m.role === "change" && <ChangeCard repo={repo} number={number} track={m.track} />}
            </div>
          ),
        )}
        {busy === "ask" && <p className="text-[12px] text-muted-foreground">Reading the change…</p>}
        <div ref={end} />
      </div>
      <div className="space-y-2 border-t border-border/60 p-3">
        {messages.length === 0 && !quote && (
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
        {quote && <QuoteChip quote={quote} onDrop={clearQuote} />}
        <Textarea
          ref={input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !isImeKeydown(e.nativeEvent)) {
              e.preventDefault();
              void primary();
            }
          }}
          placeholder={intent === "change" && canChange ? "What should change?" : "Ask about this PR"}
          className="min-h-16 text-[13px]"
          disabled={busy !== null}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">{note}</span>
          <span className="flex gap-1.5">
            {canChange && (
              <Button
                size="sm"
                variant={intent === "change" ? "default" : "outline"}
                onClick={() => void requestChange()}
                disabled={busy !== null || !draft.trim()}
                title="The PR's session makes the change and pushes it to this PR"
              >
                <Wand2 />
                {busy === "change" ? "Sending…" : "Ask for a change"}
              </Button>
            )}
            <Button
              size="sm"
              variant={intent === "change" && canChange ? "outline" : "default"}
              onClick={() => void ask(draft)}
              disabled={busy !== null || !draft.trim()}
              aria-label="Ask"
              title="Ask about this PR"
            >
              <ArrowUp />
            </Button>
          </span>
        </div>
      </div>
    </aside>
  );
}
