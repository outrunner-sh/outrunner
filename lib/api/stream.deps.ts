/**
 * GET /workspaces/{id}/stream (and a run's, /runs/{run_id}/stream): the
 * session's box's event stream, as the API's events (lib/api/stream.ts),
 * held open while it goes on. A session still being set up (or woken) is
 * waited for, with `status: preparing`; one whose box isn't up (paused,
 * archived) is refused: its conversation and runs are read without a stream.
 *
 * A stream lasts at most MAX_STREAM_MS, then ends with `done` and
 * `reconnect: true`: a client goes on with Last-Event-ID, as after any drop.
 */

import { parseFrame, QUIET_MS, FIRST_FRAME_MS } from "@/lib/api/conversation";
import { apiError } from "@/lib/api/errors";
import type { ApiContext } from "@/lib/api/handler";
import { liveEventsUrl } from "@/lib/api/live";
import { apiStatus } from "@/lib/api/serialize";
import { sseText, StreamProjector, streamStart, type StreamEvent } from "@/lib/api/stream";
import { apiChat, ownSession } from "@/lib/api/workspaces";
import { getWorkspace } from "@/lib/db/repositories";
import type { Workspace } from "@/lib/runtime/types";
import { holdActingUser } from "@/lib/supabase/acting-user";

export const MAX_STREAM_MS = 15 * 60_000;
const HEARTBEAT_MS = 15_000;
const PREPARING_POLL_MS = 3_000;
/** Streams one key (or CLI token) may hold open at once. */
export const MAX_OPEN_STREAMS = 20;

const open = new Map<string, number>();

const WAITED_FOR = new Set(["preparing", "resuming", "restoring"]);

/** `run` (by id, or by number) streams that run alone; `translate` says each
 *  event in another API's words (lib/api/cursor.ts), or leaves it out (null). */
export async function streamApi(
  context: ApiContext,
  id: string,
  run?: string | { number: number },
  translate?: (event: StreamEvent) => StreamEvent | null,
): Promise<Response> {
  const params = new URL(context.request.url).searchParams;
  // `lastEventId` is Cursor's name for it, for a client that can't set headers.
  const start = streamStart(context.request.headers.get("last-event-id"), params.get("after_event") ?? params.get("lastEventId"));
  if (start === undefined) return apiError(400, "`Last-Event-ID` (or `after_event`) is an event's id.");
  const workspace = await ownSession(context, id);
  if (workspace instanceof Response) return workspace;
  const chat = await apiChat(workspace, params.get("chat_id") ?? undefined);
  if (chat instanceof Response) return chat;
  const status = apiStatus(workspace.status);
  if (status !== "ready" && !WAITED_FOR.has(status)) {
    return apiError(409, `The session is ${status}, so it has no live stream. Read its runs or conversation, or resume it first.`);
  }
  const credential = context.caller.keyId ?? context.caller.cliTokenId ?? context.caller.userId;
  if ((open.get(credential) ?? 0) >= MAX_OPEN_STREAMS) {
    return apiError(429, `A key holds at most ${MAX_OPEN_STREAMS} streams open at once. Close one first.`);
  }
  open.set(credential, (open.get(credential) ?? 0) + 1);
  const release = holdActingUser();
  const upstream = new AbortController();
  const ended = () => context.request.signal.aborted || upstream.signal.aborted;
  context.request.signal.addEventListener("abort", () => upstream.abort());

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: StreamEvent) => {
        const said = translate ? translate(event) : event;
        if (said && !ended()) controller.enqueue(encoder.encode(sseText(said)));
      };
      const deadline = Date.now() + MAX_STREAM_MS;
      const heartbeat = setInterval(() => send({ event: "heartbeat", id: null, data: {} }), HEARTBEAT_MS);
      const stop = setTimeout(() => upstream.abort(), MAX_STREAM_MS);
      try {
        const ready = await untilReady(workspace, send, deadline, ended);
        if (!ready) return;
        await pump(ready, chat, new StreamProjector(start, run), send, upstream.signal);
        if (!ended()) send({ event: "done", id: null, data: {} });
      } catch (error) {
        if (!ended()) {
          console.warn(`API: ${id}'s stream failed`, error);
          send({ event: "error", id: null, data: { code: "upstream_unavailable", message: "The session's box stopped answering. Reconnect with Last-Event-ID." } });
          send({ event: "done", id: null, data: {} });
        }
      } finally {
        if (Date.now() >= deadline && !context.request.signal.aborted) {
          try {
            controller.enqueue(encoder.encode(sseText({ event: "done", id: null, data: { reconnect: true } })));
          } catch {
            // Closed already.
          }
        }
        clearInterval(heartbeat);
        clearTimeout(stop);
        upstream.abort();
        release();
        open.set(credential, Math.max(0, (open.get(credential) ?? 1) - 1));
        if (open.get(credential) === 0) open.delete(credential);
        try {
          controller.close();
        } catch {
          // The client went: nothing to close.
        }
      }
    },
    cancel() {
      upstream.abort();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}

/** The session once it's ready, waited for while it's set up or woken
 *  (`status: preparing` each poll); null when it won't be (it failed or
 *  stopped, the stream's time ran out, or the client went). */
async function untilReady(
  workspace: Workspace,
  send: (event: StreamEvent) => void,
  deadline: number,
  ended: () => boolean,
): Promise<Workspace | null> {
  let current: Workspace | null = workspace;
  while (current && WAITED_FOR.has(apiStatus(current.status))) {
    send({ event: "status", id: null, data: { state: "preparing", setup_phase: current.phase ?? null } });
    if (Date.now() + PREPARING_POLL_MS > deadline || ended()) return null;
    await new Promise((resolve) => setTimeout(resolve, PREPARING_POLL_MS));
    current = await getWorkspace(workspace.id);
  }
  if (!current || apiStatus(current.status) !== "ready") {
    const status = current ? apiStatus(current.status) : "deleted";
    send({ event: "error", id: null, data: { code: "conflict", message: `The session is ${status}.`, ...(current?.errorMessage && { detail: current.errorMessage }) } });
    send({ event: "done", id: null, data: {} });
    return null;
  }
  return current;
}

/** Read the box's stream into `projector`, sending what it makes, until the
 *  box's stream ends, the run it follows ends, or `signal` aborts. */
async function pump(
  workspace: Workspace,
  chat: string | undefined,
  projector: StreamProjector,
  send: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const url = await liveEventsUrl(workspace, chat);
  if (!url) throw new Error("No box to stream from");
  const response = await fetch(url, { headers: { Accept: "text/event-stream" }, cache: "no-store", signal });
  if (!response.ok || !response.body) throw new Error(`The box answered ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let replaying = true;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  // The box replays its log as fast as it reads it, then waits: once it's
  // gone quiet, the replay is in (as readUntilQuiet reads it).
  const endReplay = () => {
    if (!replaying) return;
    replaying = false;
    for (const event of projector.backlog()) send(event);
    // The run it follows was over already: the read waiting on the box ends.
    if (projector.finished) void reader.cancel().catch(() => undefined);
  };
  const armQuiet = (ms: number) => {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(endReplay, ms);
  };
  armQuiet(FIRST_FRAME_MS);
  try {
    while (!projector.finished) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const frame = parseFrame(part);
        if (!frame) continue;
        for (const event of projector.feed(frame)) send(event);
      }
      if (replaying) armQuiet(QUIET_MS);
    }
    endReplay();
  } finally {
    clearTimeout(quietTimer);
    await reader.cancel().catch(() => undefined);
  }
}
