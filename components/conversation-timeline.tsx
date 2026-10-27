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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  workingElapsed,
} from "@/lib/runtime/conversation-format";
import { claudeIsWorking } from "@/lib/runtime/conversation-events";
import {
  type ConversationNode,
  conversationNodes,
  type ConversationTurn,
  conversationTurns,
  currentTurn,
} from "@/lib/runtime/conversation-nodes";
import type { ConversationPlaceholder } from "@/lib/session/conversation-placeholder";
import { followsAfterScroll, USER_SCROLL_MS } from "@/lib/session/follow-scroll";
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
 * row that opens onto its input and output. A prompt is a full-width box, and
 * a tick on the turn rail beside the chat, which jumps to it.
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
  // Where the view was at the last scroll, for which way the next one went,
  // and to put it back where the panel is shown again (followsAfterScroll).
  const lastTop = useRef(0);
  // When the user last touched the view's scrolling (wheel, touch, keys, its
  // scrollbar), so a scroll they didn't make can't stop the follow.
  const lastInput = useRef(0);
  const userInput = () => {
    lastInput.current = performance.now();
  };

  const contentRef = useRef<HTMLDivElement | null>(null);
  const nodes = useMemo(() => conversationNodes(events), [events]);
  const turns = useMemo(() => conversationTurns(nodes), [nodes]);
  // The turn being read, as the rail marks it.
  const [current, setCurrent] = useState(-1);

  // Which turn is read: the last whose prompt is above the top third of the
  // view, or, scrolled to the end, the last.
  const measure = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const prompts = el.querySelectorAll<HTMLElement>("[data-turn]");
    const tops = Array.from(prompts, (prompt) => prompt.offsetTop);
    setCurrent(
      stickToBottom.current ? tops.length - 1 : currentTurn(tops, el.scrollTop + el.clientHeight / 3),
    );
  }, []);

  // Auto-follow: keep pinned to the bottom as the conversation grows, unless
  // the user scrolled up (then honor their position). Grows, not "as events
  // arrive": a reply keeps lengthening after its event, as its text is
  // revealed, so this follows the content's height rather than the list.
  // Also runs as a session kept for going back to is shown again, its view
  // reset by being hidden: to the end, or back where the user left it.
  useEffect(() => {
    const el = parentRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    if (!stickToBottom.current) el.scrollTop = lastTop.current;
    const follow = () => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
      measure();
    };
    follow();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    return () => observer.disconnect();
  }, [measure]);

  // A scroll is measured once a frame, however many events it fires.
  const frame = useRef<number | null>(null);
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  /** Scroll the turn's prompt to the top of the view. */
  const jumpTo = (index: number) => {
    const el = parentRef.current;
    const prompt = el?.querySelectorAll<HTMLElement>("[data-turn]")[index];
    if (!el || !prompt) return;
    // Reading back: the conversation stops following its end, as a scroll up does.
    stickToBottom.current = false;
    el.scrollTo({ top: prompt.offsetTop - 16, behavior: "smooth" });
  };

  return (
    <div className="turn-rail-host relative flex min-h-0 flex-1 flex-col">
      <div
        ref={parentRef}
        onWheel={userInput}
        onTouchMove={userInput}
        onKeyDown={userInput}
        onPointerDown={userInput}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = followsAfterScroll({
            following: stickToBottom.current,
            byUser: performance.now() - lastInput.current < USER_SCROLL_MS,
            top: el.scrollTop,
            lastTop: lastTop.current,
            viewHeight: el.clientHeight,
            scrollHeight: el.scrollHeight,
          });
          if (el.clientHeight > 0) lastTop.current = el.scrollTop;
          if (frame.current !== null) return;
          frame.current = requestAnimationFrame(() => {
            frame.current = null;
            measure();
          });
        }}
        // Positioned, so each prompt's offsetTop is from the conversation's top.
        className="relative min-h-0 flex-1 overflow-auto bg-background text-[0.8125rem] leading-relaxed text-foreground"
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
          {!placeholder && nodes.map((node) => (
            <div key={node.key} className="timeline-row" data-turn={node.kind === "prompt" ? "" : undefined}>
              <NodeRow node={node} />
            </div>
          ))}
          {working && <WorkingIndicator />}
        </div>
      </div>
      {/* One turn has nowhere else to go. */}
      {!placeholder && turns.length > 1 && <TurnRail turns={turns} current={current} onJump={jumpTo} />}
    </div>
  );
}

/**
 * The conversation's turns as ticks down the chat's left edge, the one being
 * read marked: hovering (or focusing) one shows its prompt and Claude's last
 * words in it, and clicking it scrolls there. Ticks shrink to fit a long
 * session in the rail's height.
 */
function TurnRail({
  turns,
  current,
  onJump,
}: {
  turns: ConversationTurn[];
  current: number;
  onJump: (index: number) => void;
}) {
  const [shown, setShown] = useState<number | null>(null);
  return (
    <nav aria-label="Turns" className="turn-rail" onMouseLeave={() => setShown(null)}>
      {turns.map((turn, i) => (
        <button
          key={turn.key}
          type="button"
          className={cn("turn-rail-tick", i === current && "is-current")}
          aria-label={turn.prompt || "Prompt"}
          aria-current={i === current ? "location" : undefined}
          onClick={() => onJump(i)}
          onMouseEnter={() => setShown(i)}
          onFocus={() => setShown(i)}
          onBlur={() => setShown(null)}
        >
          {shown === i && (
            <span className="turn-rail-card" aria-hidden>
              <span className="turn-rail-card-prompt">{turn.prompt || "Prompt"}</span>
              {turn.reply && <span className="turn-rail-card-reply">{turn.reply}</span>}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
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
        {workingElapsed(elapsed)}
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
