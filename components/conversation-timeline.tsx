"use client";

import {
  Bot,
  FilePlus,
  FileText,
  Globe,
  ListTodo,
  type LucideIcon,
  MessageCircleQuestionMark,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Markdown } from "@/components/markdown";
import { TickingFact } from "@/components/ui/notice";
import { DotMatrix } from "@/components/ui/loaders";
import { useStreamedText } from "@/hooks/use-streamed-text";
import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import {
  describeToolUse,
  formatTokens,
  summarizeToolResult,
  thoughtLabel,
  type ToolKind,
  toolRow,
} from "@/lib/runtime/conversation-format";
import { isInterruption } from "@/lib/runtime/conversation-events";
import { type ConversationNode, conversationNodes } from "@/lib/runtime/conversation-nodes";
import type { ConversationPlaceholder } from "@/lib/session/conversation-placeholder";
import { isLive } from "@/lib/session/streaming";
import { cn } from "@/lib/utils";

/**
 * The Conversation projection of the Workspace Session — the ordered list of
 * AgentEvents rendered as a chat. Not virtualized: every row is in the DOM,
 * but rows off screen skip layout and paint (`.timeline-row`, content-
 * visibility), which keeps a long session cheap without losing find-in-page. Every entry comes from
 * one AgentEvent; nothing is derived from PTY output (see
 * docs/architecture/session-contract.md). Each of Claude's steps is a row: its
 * words as plain prose, a thought as a quiet line, a tool call as a bordered
 * row that opens onto its input and output. A prompt is a full-width box that
 * stays pinned at the top while its turn scrolls beneath it.
 */
export function ConversationTimeline({
  events,
  placeholder = null,
  working = claudeIsWorking(events),
}: {
  events: AgentEvent[];
  /** Whether Claude is mid-turn, for the working indicator; read from the
   *  events where the caller knows no better (a stopped turn it can't see). */
  working?: boolean;
  /** What an empty conversation says (see conversationPlaceholder); a replay,
   *  which has nothing to connect to, passes none. */
  placeholder?: ConversationPlaceholder;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const contentRef = useRef<HTMLDivElement | null>(null);

  // Auto-follow: keep pinned to the bottom as the conversation grows, unless
  // the user scrolled up (then honor their position). Grows, not "as events
  // arrive": a reply keeps lengthening after its event, as its text is
  // revealed, so this follows the content's height rather than the list.
  useEffect(() => {
    const el = parentRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const follow = () => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    };
    follow();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={parentRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current =
          el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      }}
      className="min-h-0 flex-1 overflow-auto bg-background text-[0.8125rem] leading-relaxed text-foreground"
    >
      <div ref={contentRef} className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pt-10 pb-16">
        {placeholder === "connecting" && (
          <div role="status" className="conversation-placeholder">
            <DotMatrix rows={6} cols={9} />
            <span>Connecting to Claude</span>
          </div>
        )}
        {placeholder === "ready" && (
          <div className="conversation-placeholder is-ready">
            <span>Ready when you are</span>
            <span className="text-muted-foreground/60">Claude is connected. Send a prompt to start.</span>
          </div>
        )}
        {/* Under a placeholder there is only the session's state to show,
            which the placeholder already speaks for. */}
        {!placeholder && conversationNodes(events).map((node) => (
          <div key={node.key} className={cn("timeline-row", node.kind === "prompt" && "is-prompt")}>
            <NodeRow node={node} />
          </div>
        ))}
        {working && <WorkingIndicator />}
      </div>
    </div>
  );
}

/** Whether Claude is still working on the current turn — so the moving indicator
 *  shows through the whole thing, not just the gap before the first reply. It's
 *  working while the latest turn is the user's (a fresh prompt or a tool result
 *  it must act on), or while its own latest turn ended on thinking or a tool_use
 *  (more is coming). A turn that ends in text is Claude done and idle. */
export function claudeIsWorking(events: AgentEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.t === "state") {
      // A terminated session is never "working", whatever the last turn was.
      if (event.state === "exited" || event.state === "archived") return false;
      continue;
    }
    if (event.t !== "message") continue;
    // A prompt or a tool result awaiting Claude; not the record of a stop.
    if (event.role === "user") return !isInterruption(event);
    const last = event.content[event.content.length - 1];
    return last ? last.type !== "text" : false;
  }
  return false;
}

/** Live "Claude is working" affordance: a small dot-matrix wave and an elapsed
 *  timer, so activity is visible instead of a still pane. Remounts (resetting
 *  the clock) each time we re-enter the working state. The timer is tabular so
 *  the row never shifts as digits change. */
function WorkingIndicator() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 100);
    return () => clearInterval(id);
  }, []);
  return (
    <div role="status" className="flex items-center gap-2.5 py-1 text-[13px] text-muted-foreground">
      <DotMatrix rows={3} cols={3} cell={3} gap={1.5} />
      <span>Working</span>
      {/* The timer ticks ten times a second, so it stays out of the live
          region; "Working" is the announcement, once. */}
      <TickingFact className="font-mono text-[11px] tabular-nums text-muted-foreground/70">
        {(elapsed / 1000).toFixed(1)}s
      </TickingFact>
    </div>
  );
}

function NodeRow({ node }: { node: ConversationNode }) {
  switch (node.kind) {
    case "state":
      return (
        <div className="flex items-center gap-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <span className="h-px w-4 bg-border" />
          session {node.state}
        </div>
      );
    case "usage":
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1 font-mono text-[10px] text-muted-foreground">
          <span className="uppercase tracking-wider text-muted-foreground">usage</span>
          <span>
            in <span className="text-foreground">{formatTokens(node.event.input_tokens)}</span>
          </span>
          <span>
            out <span className="text-foreground">{formatTokens(node.event.output_tokens)}</span>
          </span>
          <span>
            cache-r{" "}
            <span className="text-foreground">{formatTokens(node.event.cache_read_input_tokens)}</span>
          </span>
        </div>
      );
    case "prompt":
      return <div className="timeline-prompt">{node.text}</div>;
    case "interrupted":
      return <div className="timeline-thought">Interrupted</div>;
    case "prose":
      return <Prose text={node.text} at={node.at} />;
    case "thought":
      return <div className="timeline-thought">{thoughtLabel(node.seconds)}</div>;
    case "tool":
      return <ToolRow name={node.name} input={node.input} result={node.result} />;
  }
}

/** Claude's words, revealed as they arrive (useStreamedText) with a caret at
 *  the end while more is coming. Whether it is live is decided once, when the
 *  row first appears: a reply written moments ago, not history replayed as the
 *  session opens. */
function Prose({ text, at }: { text: string; at: string }) {
  const [live] = useState(() => isLive(at, Date.now()));
  const { visible, streaming } = useStreamedText(text, live);
  return (
    <div className={cn("min-w-0 px-2", streaming && "is-streaming")} aria-busy={streaming || undefined}>
      <Markdown>{visible}</Markdown>
    </div>
  );
}

const TOOL_ICONS: Record<ToolKind, LucideIcon> = {
  command: SquareTerminal,
  create: FilePlus,
  edit: Pencil,
  read: FileText,
  search: Search,
  web: Globe,
  agent: Bot,
  todo: ListTodo,
  question: MessageCircleQuestionMark,
  other: Wrench,
};

/** One tool call: a bordered row (what it did, and the lines it changed),
 *  opening onto its input and, once it has arrived, its output. */
function ToolRow({ name, input, result }: { name: string; input: unknown; result: { content: unknown } | null }) {
  const row = toolRow(name, input);
  const Icon = TOOL_ICONS[row.kind];
  const command = name === "Bash" ? describeToolUse(name, input) : null;
  return (
    <details className="timeline-tool">
      <summary title={row.title ?? undefined}>
        <Icon aria-hidden />
        <span className={cn("min-w-0 truncate", row.mono && "font-mono text-[12px]")}>{row.label}</span>
        {row.stats && (
          <span className="shrink-0 tabular-nums">
            {row.stats.added > 0 && <span className="text-positive">+{row.stats.added}</span>}
            {row.stats.added > 0 && row.stats.removed > 0 && " "}
            {row.stats.removed > 0 && <span className="text-destructive">-{row.stats.removed}</span>}
          </span>
        )}
      </summary>
      <div className="timeline-tool-body">
        <pre>{command ?? JSON.stringify(input, null, 2)}</pre>
        {result && <ToolOutput content={result.content} />}
      </div>
    </details>
  );
}

/** A tool's output under its input, its size beside the heading. */
function ToolOutput({ content }: { content: unknown }) {
  const { text, lineCount } = summarizeToolResult(content);
  return (
    <>
      <div className="timeline-tool-heading">
        Output
        {lineCount > 1 && <span className="tabular-nums">{lineCount} lines</span>}
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap">{lineCount === 0 ? "(empty result)" : text}</pre>
    </>
  );
}
