"use client";

import { RunnerEventCards } from "@/components/missions/runner-event-cards";
import { parseRunnerEvents } from "@/lib/missions/events";
import {
  Bot,
  Check,
  Clock,
  ChevronRight,
  Copy,
  FilePlus,
  FoldVertical,
  FileText,
  GitFork,
  Globe,
  ListChecks,
  ListTodo,
  type LucideIcon,
  MessageCircleQuestionMark,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { type MessageFile, MessageAttachments, promptFiles } from "@/components/attachment-thumbnails";
import { ImageBoxContext, Markdown } from "@/components/markdown";
import { type PlanActions, PlanCard } from "@/components/plan-card";
import { TickingFact } from "@/components/ui/notice";
import { DotMatrix, ThinkingIcon } from "@/components/ui/loaders";
import { StartupStatus, type SessionStartup } from "@/components/workspace-creating";
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
import { promptAttachments } from "@/lib/runtime/attachments";
import { claudeIsWorking, workingStep } from "@/lib/runtime/conversation-events";
import { compactTokens } from "@/lib/runtime/context-usage";
import {
  type ConversationNode,
  conversationNodes,
  type PromptImage,
  type ConversationTurn,
  conversationTurns,
  conversationTurnSince,
  currentTurn,
} from "@/lib/runtime/conversation-nodes";
import { messageTime, workedFor } from "@/lib/runtime/turn-timing";
import type { ConversationPlaceholder } from "@/lib/session/conversation-placeholder";
import { lineRange, parseCommentQuotes } from "@/lib/session/diff-comments";
import { FOLLOW_SLACK_PX, followsAfterScroll, USER_SCROLL_MS } from "@/lib/session/follow-scroll";
import { isLive } from "@/lib/session/streaming";
import { editPromptText } from "@/lib/session/edit-message";
import { cn } from "@/lib/utils";

/** Long enough for any smooth scroll back to a turn to finish. */
const JUMP_MS = 1500;

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
  startup,
  agentLabel = "Claude Code",
  working = claudeIsWorking(events),
  compacting = false,
  plansInProse = false,
  plan = null,
  onEdit,
}: {
  events: AgentEvent[];
  /** Startup uses the same in-conversation position as the working indicator. */
  startup?: SessionStartup;
  /** The actual selected harness, including before its first reply. */
  agentLabel?: string;
  /** Whether Claude is mid-turn, for the working indicator; read from the
   *  events where the caller knows no better (a stopped turn it can't see). */
  working?: boolean;
  /** A compaction asked for and not yet in the stream: the working
   *  indicator says so. */
  compacting?: boolean;
  /** The agent has no plan step (Codex): a plan-mode turn's last words are
   *  its plan (conversationNodes). */
  plansInProse?: boolean;
  /** The plan waiting on the user (its card's `id`), and its answers. */
  plan?: (PlanActions & { id: string }) | null;
  /** What an empty conversation says (see conversationPlaceholder); a replay,
   *  which has nothing to connect to, passes none. */
  placeholder?: ConversationPlaceholder;
  /** Edit a sent prompt (its pencil, on hover): absent while it can't be,
   *  the agent mid-turn, and in a replay. */
  onEdit?: (uuid: string, text: string) => void;
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
  // A pointer held on the view (dragging its scrollbar) is the user's however
  // long the drag lasts; it's let go anywhere on the page.
  const pointerHeld = useRef(false);
  const holdPointer = () => {
    userInput();
    pointerHeld.current = true;
    const release = () => {
      pointerHeld.current = false;
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
  };
  // Where a jump back to a turn (the turn rail) is headed, until it gets there,
  // the user takes over, or it has had its time.
  const jumpingTo = useRef<{ top: number; since: number } | null>(null);
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const contentRef = useRef<HTMLDivElement | null>(null);
  const nodes = useMemo(() => conversationNodes(events, { plansInProse, working }), [events, plansInProse, working]);
  // When the turn under way began, for the working clock: its prompt's time,
  // so a page opened mid-turn shows how long it has really run.
  const turnSince = useMemo(() => conversationTurnSince(nodes), [nodes]);
  // What Claude is at while it works: thinking, or running a tool.
  const step = useMemo(() => workingStep(events), [events]);
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
    if (jumpTimer.current) clearTimeout(jumpTimer.current);
  }, []);

  /** Scroll the turn's prompt to the top of the view. */
  const jumpTo = (index: number) => {
    const el = parentRef.current;
    const prompt = el?.querySelectorAll<HTMLElement>("[data-turn]")[index];
    if (!el || !prompt) return;
    // Reading back: the conversation stops following its end, as a scroll up
    // does, for the whole of the smooth scroll there.
    const top = Math.max(0, Math.min(prompt.offsetTop - 16, el.scrollHeight - el.clientHeight));
    // One that lands within reach of the end is a return there: following
    // again, whatever jump back was still under way.
    if (el.scrollHeight - top - el.clientHeight < FOLLOW_SLACK_PX) {
      jumpingTo.current = null;
      if (jumpTimer.current) clearTimeout(jumpTimer.current);
      stickToBottom.current = true;
      el.scrollTo({ top, behavior: "smooth" });
      return;
    }
    stickToBottom.current = false;
    jumpingTo.current = { top, since: performance.now() };
    if (jumpTimer.current) clearTimeout(jumpTimer.current);
    jumpTimer.current = setTimeout(() => {
      jumpingTo.current = null;
    }, JUMP_MS);
    el.scrollTo({ top, behavior: "smooth" });
  };

  return (
    <div className="turn-rail-host relative flex min-h-0 flex-1 flex-col">
      <div
        ref={parentRef}
        // Focusable, so keys that scroll it after a click in it come through it.
        tabIndex={-1}
        onWheel={userInput}
        onTouchMove={userInput}
        onKeyDown={userInput}
        onPointerDown={holdPointer}
        onScroll={(e) => {
          const el = e.currentTarget;
          const byUser = pointerHeld.current || performance.now() - lastInput.current < USER_SCROLL_MS;
          // A jump ends where it was headed, or as the user takes over: by
          // input since it began, not a trackpad's momentum from before.
          const jump = jumpingTo.current;
          if (
            jump &&
            (pointerHeld.current || lastInput.current > jump.since || Math.abs(el.scrollTop - jump.top) < 2)
          ) {
            jumpingTo.current = null;
          }
          stickToBottom.current = followsAfterScroll({
            following: stickToBottom.current,
            byUser,
            jumping: jumpingTo.current !== null,
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
        className="timeline-scroll relative min-h-0 flex-1 overflow-auto bg-background outline-none text-[0.8125rem] leading-relaxed text-foreground"
      >
        <div ref={contentRef} className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pt-10 pb-16">
          {placeholder === "connecting" && (
            <div role="status" className="conversation-placeholder">
              <DotMatrix rows={6} cols={9} />
              <span>Connecting to {agentLabel}</span>
            </div>
          )}
          {placeholder === "ready" && (
            <div className="conversation-placeholder is-ready">
              <span>Ready when you are</span>
              <span className="text-muted-foreground">{agentLabel} is connected. Send a prompt to start.</span>
            </div>
          )}
          {/* Under a placeholder there is only the session's state to show,
              which the placeholder already speaks for. */}
          {!placeholder && nodes.map((node) => (
            <div key={node.key} className="timeline-row" data-turn={node.kind === "prompt" && !node.continuation ? "" : undefined}>
              <NodeRow node={node} plan={node.kind === "plan" && plan?.id === node.id ? plan : undefined} onEdit={onEdit} />
            </div>
          ))}
          {startup ? <StartupStatus startup={startup} /> : (working || compacting) && (
            // A compaction counts from when it began here: the last prompt's
            // time may be long before it (a typed /compact is no prompt row).
            <WorkingIndicator
              label={compacting ? "Compacting conversation" : step.label}
              since={compacting ? undefined : turnSince}
              stepSince={compacting ? null : step.since}
            />
          )}
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
 *  timer, so activity is visible instead of a still pane. The clock runs from
 *  the turn's prompt (`since`) where it has a time, else from when the
 *  indicator showed; it remounts each time we re-enter the working state. The
 *  timer is tabular so the row never shifts as digits change. */
function WorkingIndicator({ label, since, stepSince = null }: { label: string; since?: string; stepSince?: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  const [shownAt] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);
  // A time ahead of this clock (skew) or long gone (a turn that never ended)
  // is no start to count from.
  const from = (at: string | null | undefined) => {
    const t = at ? Date.parse(at) : NaN;
    return Number.isFinite(t) && t <= now && now - t < 6 * 3_600_000 ? t : shownAt;
  };
  const turn = now - from(since);
  // The step's own clock, once it has run a while: a long think, or a long
  // tool, says how long it has been at it, not only the turn.
  const step = stepSince ? now - from(stepSince) : 0;
  return (
    <div role="status" className="flex items-center gap-2.5 py-1 text-[13px] text-muted-foreground">
      <ThinkingIcon />
      <span>{label}</span>
      {/* The timer ticks ten times a second, so it stays out of the live
          region; the label is the announcement, once per step. */}
      <TickingFact className="font-mono text-[11px] tabular-nums text-muted-foreground/70">
        {step >= 10_000 && turn - step >= 1_000 ? `${workingElapsed(step)} · ${workingElapsed(turn)} turn` : workingElapsed(turn)}
      </TickingFact>
    </div>
  );
}

function NodeRow({
  node,
  plan,
  onEdit,
}: {
  node: ConversationNode;
  plan?: PlanActions;
  onEdit?: (uuid: string, text: string) => void;
}) {
  switch (node.kind) {
    case "harness":
      return <div className="timeline-compact" role="note">{node.from === "claude" ? "Claude Code" : "Codex"} → {node.to === "claude" ? "Claude Code" : "Codex"} · Context handed over</div>;
    case "plan":
      return <PlanCard text={node.text} actions={plan} />;
    case "compact":
      return (
        <div className="timeline-compact" role="note">
          <FoldVertical aria-hidden />
          {compactionLabel(node)}
        </div>
      );
    case "command":
      return <div className="timeline-thought font-mono text-[12.5px]">{node.text}</div>;
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
    case "prompt": {
      // A Mission's news from its Runners: cards, not markup.
      if (node.text.includes("<runner_event")) {
        const { events, rest } = parseRunnerEvents(node.text);
        if (events.length > 0) return <RunnerEventCards events={events} note={rest || undefined} />;
      }
      const uuid = node.uuid;
      return (
        <Prompt
          text={node.text}
          mode={node.mode}
          at={node.at}
          images={node.images}
          carried={node.carried}
          onEdit={
            uuid && onEdit
              ? () => onEdit(uuid, editPromptText(node.text))
              : undefined
          }
        />
      );
    }
    case "worked":
      return (
        <div className="timeline-worked">
          <Clock aria-hidden />
          {workedFor(node.ms)}
          <MessageTime at={node.at} />
        </div>
      );
    case "meta":
      return <Meta label={node.label} text={node.text} />;
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

/** A prompt longer than this shows its first lines, with Show more. */
const LONG_PROMPT_CHARS = 800;
const LONG_PROMPT_LINES = 10;

/** The user's prompt: the files it carried as thumbnails above its words,
 *  not the paths written for the agent, and the comments on the diff
 *  (withComments) as quotes under them, not the blocks. */
function Prompt({
  text,
  mode,
  at,
  images,
  carried,
  onEdit,
}: {
  text: string;
  mode?: "plan";
  at?: string;
  images?: PromptImage[];
  carried?: ("handoff" | "side")[];
  onEdit?: () => void;
}) {
  // The pencil, on hover: the prompt's words go to the composer, and sending
  // them replaces it and everything after it.
  const edit = onEdit && (
    <button
      type="button"
      className="timeline-prompt-edit"
      onClick={onEdit}
      title="Edit: sending replaces this message and everything after it (files and git changes aren't rolled back)"
      aria-label="Edit message"
    >
      <Pencil aria-hidden />
    </button>
  );
  const workspaceId = useContext(ImageBoxContext);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const [open, setOpen] = useState(false);
  const { typed, files } = useMemo(() => {
    const { text: typed, files: paths } = promptAttachments(text);
    const pasted: MessageFile[] = (images ?? []).map((image, i) => ({
      key: `pasted-${i}`,
      name: `Image ${i + 1}`,
      src: `data:${image.mediaType};base64,${image.data}`,
      image: true,
    }));
    return { typed, files: [...pasted, ...promptFiles(paths, workspaceId)] };
  }, [text, images, workspaceId]);
  const { text: said, quotes } = useMemo(() => parseCommentQuotes(typed), [typed]);
  const copy = typed.trim() && (
    <button
      type="button"
      className="timeline-prompt-edit"
      onClick={() => void navigator.clipboard?.writeText(typed.trim()).then(() => setCopied(true), () => {})}
      title={copied ? "Copied" : "Copy message"}
      aria-label={copied ? "Copied" : "Copy message"}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
    </button>
  );
  // A long prompt shows its first lines until it's opened.
  const long = said.length > LONG_PROMPT_CHARS || said.split("\n").length > LONG_PROMPT_LINES;
  const words = long ? (
    <>
      <div className={cn("timeline-prompt-words", !open && "is-clamped")}>{said}</div>
      <button type="button" className="timeline-prompt-more" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Show less" : "Show more"}
      </button>
    </>
  ) : said;
  const attached = files.length > 0 && <MessageAttachments files={files} />;
  // Sent in plan mode: said, quietly, above its words; and so is what a
  // chat's prompt carried from another chat, which the agent was given.
  const planned = (mode === "plan" || carried) && (
    <>
      {mode === "plan" && (
        <span className="timeline-prompt-mode">
          <ListChecks aria-hidden />
          Plan mode
        </span>
      )}
      {carried?.includes("handoff") && (
        <span
          className="timeline-prompt-mode"
          title="Sent with the conversation it continues (a fork's, or this chat's before an edit): a transcript in .context/chats and its latest turns"
        >
          <GitFork aria-hidden />
          With the earlier conversation
        </span>
      )}
      {carried?.includes("side") && (
        <span className="timeline-prompt-mode" title="Sent with the newest turns of the chat this side chat is about">
          <MessageCircleQuestionMark aria-hidden />
          With the source chat&apos;s newest turns
        </span>
      )}
    </>
  );
  if (quotes.length === 0)
    return (
      <div className="timeline-prompt">
        {at && <MessageTime at={at} />}
        {edit}
        {copy}
        {planned}
        {attached}
        {words}
      </div>
    );
  return (
    <div className="timeline-prompt">
      {at && <MessageTime at={at} />}
      {edit}
      {copy}
      {planned}
      {attached}
      {words}
      <div className={cn("timeline-quotes", words && "mt-2.5")}>
        {quotes.map((quote, i) => (
          <figure key={i} className="timeline-quote">
            <figcaption>
              <span className="font-mono">
                {quote.path}:{lineRange(quote.startLine, quote.endLine).replace("-", "–")}
              </span>
              {quote.side === "old" && <span>removed</span>}
            </figcaption>
            {quote.code && <pre>{quote.code}</pre>}
            <p>{quote.comment}</p>
          </figure>
        ))}
      </div>
    </div>
  );
}

/** An internal record Claude injected (a skill's instructions, a reminder):
 *  folded behind a quiet one-line disclosure, so the conversation keeps its
 *  flow but the text is a click away, like Conductor. */
function Meta({ label, text }: { label: string; text: string }) {
  return (
    <details className="timeline-meta">
      <summary>
        <ChevronRight aria-hidden />
        <span className="font-medium">{label}</span>
      </summary>
      <pre>{text}</pre>
    </details>
  );
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
function ToolRow({
  name,
  input,
  result,
}: {
  name: string;
  input: unknown;
  result: { content: unknown; isError?: boolean } | null;
}) {
  const row = toolRow(name, input);
  const Icon = TOOL_ICONS[row.kind];
  const command = name === "Bash" ? describeToolUse(name, input) : null;
  const failed = result?.isError === true;
  return (
    <details className={cn("timeline-tool", failed && "is-failed")}>
      <summary title={row.title ?? undefined}>
        <Icon aria-hidden />
        <span className={cn("min-w-0 truncate", row.mono && "font-mono text-[12px]")}>{row.label}</span>
        {failed && <span className="shrink-0 text-destructive">Failed</span>}
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
        {result && <ToolOutput content={result.content} failed={failed} />}
      </div>
    </details>
  );
}

/** A tool's output under its input, its size beside the heading. */
function ToolOutput({ content, failed }: { content: unknown; failed: boolean }) {
  const { text, lineCount } = summarizeToolResult(content);
  return (
    <>
      <div className={cn("timeline-tool-heading", failed && "text-destructive")}>
        {failed ? "Error" : "Output"}
        {lineCount > 1 && <span className="tabular-nums">{lineCount} lines</span>}
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap">{lineCount === 0 ? "(empty result)" : text}</pre>
    </>
  );
}

/** "Conversation compacted · 45.2k tokens summarized", or as much as the log
 *  says; "automatically" when the agent did it itself as its context filled. */
function compactionLabel(node: Extract<ConversationNode, { kind: "compact" }>): string {
  const how = node.trigger === "auto" ? "Conversation compacted automatically" : "Conversation compacted";
  return node.preTokens ? `${how} · ${compactTokens(node.preTokens)} tokens summarized` : how;
}

const noSubscription = () => () => {};

/** A message's time, its full date and time on hover. In the browser's time
 *  zone, so not on the server: a replay rendered there would say another
 *  hour than the page it hydrates (useSyncExternalStore's server snapshot is
 *  none). */
function MessageTime({ at }: { at: string }) {
  const label = useSyncExternalStore(noSubscription, () => messageTime(at), () => null);
  if (!label) return null;
  return (
    <time className="timeline-time" dateTime={at} title={new Date(at).toLocaleString()}>
      {label}
    </time>
  );
}
