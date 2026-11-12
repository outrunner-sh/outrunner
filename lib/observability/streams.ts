import type { OutgoingHttpHeaders, ServerResponse } from "node:http";

/**
 * Event streams (text/event-stream: the review conversation stream, the
 * API's live stream, a preview's) only end when the client leaves, so a
 * shutdown can't wait for them: it would always take its whole limit.
 * server.ts counts each request as under way until its response ends;
 * this lets go of that hold once the response is seen to be an event
 * stream, and keeps it in `open`, for the shutdown to end (EventSource
 * reconnects by itself, as the relays' 1012 makes the WebSockets do).
 *
 * Seen at writeHead, which Node calls for an implicit header too.
 */
export function watchEventStream(res: ServerResponse, release: () => void, open: Set<ServerResponse>): void {
  const writeHead = res.writeHead;
  res.writeHead = function (this: ServerResponse, ...args: unknown[]) {
    res.writeHead = writeHead;
    if (isEventStream(this.getHeader("content-type")) || isEventStream(contentTypeIn(args))) {
      release();
      open.add(this);
      this.once("close", () => open.delete(this));
    }
    return (writeHead as (...a: unknown[]) => ServerResponse).apply(this, args);
  } as typeof res.writeHead;
}

function isEventStream(value: unknown): boolean {
  const type = Array.isArray(value) ? value.join(",") : String(value ?? "");
  return type.trim().toLowerCase().startsWith("text/event-stream");
}

/** The content type in writeHead's headers argument, an object or a flat
 *  [name, value, …] array, after an optional status message. */
function contentTypeIn(args: unknown[]): unknown {
  const headers = typeof args[1] === "string" ? args[2] : args[1];
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === "content-type") return headers[i + 1];
    }
    return undefined;
  }
  if (!headers || typeof headers !== "object") return undefined;
  for (const [name, value] of Object.entries(headers as OutgoingHttpHeaders)) {
    if (name.toLowerCase() === "content-type") return value;
  }
  return undefined;
}
