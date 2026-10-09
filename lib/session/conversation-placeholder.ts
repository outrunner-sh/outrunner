/** What an empty conversation says, from how far the session has connected. */
export type ConversationPlaceholder = "connecting" | "ready" | null;

/**
 * An empty conversation is either still connecting (the attach or the event
 * stream is on its way) or connected with nothing said yet. Once anything is
 * in it, or the connection failed (the error banner speaks then), it says
 * nothing.
 */
export function conversationPlaceholder(input: {
  events: number;
  attachment: "idle" | "loading" | "attached" | "error";
  stream: "loading" | "connecting" | "connected" | "disconnected" | "error";
}): ConversationPlaceholder {
  if (input.events > 0) return null;
  if (input.attachment === "error" || input.stream === "error") return null;
  if (input.attachment !== "attached") return "connecting";
  if (input.stream === "connected") return "ready";
  // Attached, with the stream opening or reopening.
  return "connecting";
}
