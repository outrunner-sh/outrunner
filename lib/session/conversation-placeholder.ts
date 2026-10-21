import type { AgentEvent } from "@/lib/runtime/agent-protocol";

/** What an empty conversation says, from how far the session has connected. */
export type ConversationPlaceholder = "connecting" | "ready" | null;

/**
 * An empty conversation is either still connecting (the attach or the event
 * stream is on its way) or connected with nothing said yet. Once anything is
 * said in it, or the connection failed (the error banner speaks then), it says
 * nothing. A session's state is not something said: the stream opens with one
 * ahead of the history it replays, which must not leave a bare "session
 * running" over an empty page while that history is on its way. A session that
 * has ended is the exception: its state row says so, rather than "ready".
 */
export function conversationPlaceholder(input: {
  events: AgentEvent[];
  attachment: "idle" | "loading" | "attached" | "error";
  stream: "loading" | "connecting" | "connected" | "disconnected" | "error";
}): ConversationPlaceholder {
  if (input.events.some((event) => event.t !== "state")) return null;
  if (input.events.some((event) => event.t === "state" && (event.state === "exited" || event.state === "archived"))) {
    return null;
  }
  if (input.attachment === "error" || input.stream === "error") return null;
  if (input.attachment !== "attached") return "connecting";
  if (input.stream === "connected") return "ready";
  // Attached, with the stream opening or reopening.
  return "connecting";
}
