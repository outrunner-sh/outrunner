/**
 * A Mission's Slack tools (docs/missions.md, "On call in Slack"):
 * slack_reply, slack_ask and slack_react, and what spawn_runner and
 * message_runner do for a Mission on call. The only way a Mission talks in
 * Slack, and only in a thread of its own bound channel: a thread of another
 * Mission, of another channel, or one muted, reads as no thread. No other
 * channel, no DMs.
 *
 * Posts aren't sent here: they're queued (lib/missions/slack-outbox.ts) under
 * a stable key, so a tool call tried again is one post, and the tools say
 * "queued". The queue checks again right before each goes.
 *
 * A Ship start on call has a stable key: the request it's for (`request_id`,
 * from the <slack_request>) and the Mission's own `spawn_key`. The key, its
 * place under the limits, and the session id the Ship will have are reserved
 * before the session is made, so a retry returns that Ship rather than
 * starting another. A place is given back only when no Ship can have been
 * made: a timeout is no proof.
 *
 * What touches the world comes in as `deps` (MissionSlackDeps, wired in
 * lib/missions/tools.deps.ts), so the scoping tests without Slack.
 */

import { createHash } from "node:crypto";

import type { QueueOutcome, QueuedPost, SlackBlocks } from "@/lib/missions/slack-outbox";
import type { MissionChannel, MissionRequest, MissionThread, ShipLedger, SpawnReservation } from "@/lib/missions/slack-store";
import { limitText, quietText, reactionName } from "@/lib/missions/slack-text";
import type { Workspace } from "@/lib/runtime/types";
import { markdownToSlack, slackChunks } from "@/lib/slack/research-text";

export type MissionSlackDeps = {
  binding(missionId: string): Promise<MissionChannel | null>;
  /** One of the Mission's threads by its ts, whatever its channel. */
  thread(missionId: string, threadTs: string): Promise<MissionThread | null>;
  threadById(id: string): Promise<MissionThread | null>;
  request(missionId: string, requestKey: string): Promise<MissionRequest | null>;
  latestRequest(threadId: string): Promise<MissionRequest | null>;
  /** Whether someone can still read the Mission's project. */
  canRead(userId: string, mission: Workspace): Promise<boolean>;
  /** Queue a post under its key (slack-outbox.deps.ts's queuePost). */
  queue(post: QueuedPost): Promise<QueueOutcome>;
  saveAsk(input: { missionId: string; threadId: string; question: string; options: string[]; opKey: string; bindingRevision: string }): Promise<string>;
  askBlocks(askId: string, question: string, options: string[]): SlackBlocks;
  reserveSpawn(input: {
    missionId: string;
    requestKey: string | null;
    spawnKey: string;
    threadId: string | null;
    requester: string | null;
    requesterSlack: string | null;
    revision: string;
  }): Promise<SpawnReservation>;
  linkShip(id: string, runnerId: string): Promise<void>;
  releaseShip(id: string): Promise<void>;
  ledger(runnerId: string): Promise<ShipLedger | null>;
  /** The org's audit log: a Ship started from Slack. */
  auditShip(mission: Workspace, binding: MissionChannel, request: MissionRequest | null, runnerId: string): Promise<void>;
  /** Who asked, for the Ship's brief: their name, and the thread's link. */
  requesterName(request: MissionRequest, thread: MissionThread | null): Promise<{ name: string; permalink: string | null }>;
};

export type ToolResult = { text: string; isError?: boolean };

const THREAD = {
  type: "string",
  description: "The thread a <slack_request> came from: its thread attribute (a Slack ts like 1731400000.123456).",
};
const REQUEST_ID = { type: "string", description: "The request_id attribute of the <slack_request> this is for." };
const POST_KEY = {
  type: "string",
  description: "Optional: your own key for this post (letters, digits, . _ : -). The same key in the same thread is one post, however often it's called.",
};

export const SLACK_TOOLS = [
  {
    name: "slack_reply",
    description:
      "Post in a thread of this Mission's Slack channel, the one a <slack_request> came from. Markdown, made Slack's mrkdwn; long text goes in several messages. Queued and posted shortly: calling it again with the same text (or post_key) for the same request is one post. The only way to talk in Slack: you can't post anywhere else or send DMs.",
    inputSchema: {
      type: "object",
      properties: { thread: THREAD, text: { type: "string", description: "What to say, in Markdown." }, post_key: POST_KEY },
      required: ["thread", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "slack_ask",
    description:
      "Ask a question in a thread as a card with buttons, plus Other (which asks people to reply in the thread). Queued and posted shortly. The first answer comes back to you as a <slack_answer> block. Use it when a request is ambiguous or needs a decision.",
    inputSchema: {
      type: "object",
      properties: {
        thread: THREAD,
        question: { type: "string", description: "The question, in Slack mrkdwn." },
        options: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5, description: "1 to 5 short answers (up to 75 characters each)." },
      },
      required: ["thread", "question", "options"],
      additionalProperties: false,
    },
  },
  {
    name: "slack_react",
    description:
      'Mark a request\'s message with an emoji: "eyes" (taken on), "white_check_mark" (done) or "x" (failed). The request named by request_id, or the thread\'s latest.',
    inputSchema: {
      type: "object",
      properties: { thread: THREAD, emoji: { type: "string", enum: ["eyes", "white_check_mark", "x"] }, request_id: REQUEST_ID },
      required: ["thread", "emoji"],
      additionalProperties: false,
    },
  },
] as const;

export const SLACK_TOOL_NAMES: readonly string[] = SLACK_TOOLS.map((t) => t.name);

/** spawn_runner's arguments on call. */
export const SPAWN_SLACK_PROPERTIES = {
  request_id: {
    type: "string",
    description: "On call in Slack: the request_id of the <slack_request> the Ship is for. It's linked to that request and its thread, the requester named in its brief, and its pull requests posted there.",
  },
  spawn_key: {
    type: "string",
    description:
      "On call in Slack, required: a short stable name for this Ship start (letters, digits, . _ : -), e.g. \"fix-login\". Unique per request: the same request_id and spawn_key is the same Ship, so call again with them if a call failed or timed out. Use a new key for each distinct Ship.",
  },
  thread: { type: "string", description: "Older form of request_id: the thread of a <slack_request>; its latest request is used." },
};

const SPAWN_KEY = /^[A-Za-z0-9._:-]{1,80}$/;
const POST_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;

function refuse(text: string): ToolResult {
  return { text, isError: true };
}

function hash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

const NO_SUCH_THREAD = "This Mission has no such thread in its Slack channel. Use the thread attribute of the <slack_request> you're answering.";
const NO_SUCH_REQUEST = "This Mission has no such request in its Slack channel. Use the request_id attribute of a <slack_request>.";
const NOT_ON_CALL = "This Mission isn't on call in a Slack channel, so its Slack tools are off.";
const MUTED = "That thread is muted (!mute): don't post there until someone says !unmute.";

function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/** The thread named, if it's this Mission's, in the channel it's on call in
 *  now; or why not. */
export async function scopedThread(
  mission: Workspace,
  threadTs: unknown,
  deps: MissionSlackDeps,
): Promise<{ binding: MissionChannel; thread: MissionThread } | { error: string }> {
  const binding = await deps.binding(mission.id);
  if (!binding) return { error: NOT_ON_CALL };
  if (typeof threadTs !== "string" || !/^\d{1,12}\.\d{1,8}$/.test(threadTs.trim())) return { error: NO_SUCH_THREAD };
  const thread = await deps.thread(mission.id, threadTs.trim());
  if (!thread || !inChannel(thread, mission, binding)) return { error: NO_SUCH_THREAD };
  if (thread.muted) return { error: MUTED };
  return { binding, thread };
}

function inChannel(thread: MissionThread, mission: Workspace, binding: MissionChannel): boolean {
  return thread.missionId === mission.id && thread.teamId === binding.teamId && thread.channelId === binding.channelId;
}

/** A post for the queue, in the thread, under the binding as it is now. */
function postIn(
  binding: MissionChannel,
  thread: MissionThread,
  post: Pick<QueuedPost, "opKey" | "kind" | "payload" | "requester">,
): QueuedPost {
  return {
    ...post,
    missionId: binding.missionId,
    bindingRevision: binding.revision,
    teamId: binding.teamId,
    channelId: binding.channelId,
    threadTs: thread.threadTs,
  };
}

/** What the channel is told of a Ship the platform refused to start: one
 *  fixed sentence per kind, never the refusal's own words. Those carry the
 *  owner's spend and plan (dollar amounts, limits), which everyone in the
 *  channel would read; the full reason stays in the Mission's tool result. */
export function refusalSaid(reason: string): string {
  if (/concurrent cloud sessions/i.test(reason)) return "The Mission owner's plan has no room for another cloud session right now.";
  if (/cloud usage|usage limit|overage|free trial/i.test(reason)) return "The Mission owner's cloud usage is used up for now.";
  return "Outrunner couldn't start it right now.";
}

/** A Ship the platform refused to start is said in the request's thread by
 *  the server, whatever the Mission does next: a thread must never just go
 *  quiet. Ships run as the Mission's owner, on the owner's plan. Best
 *  effort; whether it was queued. */
export async function tellStartRefused(start: Pick<SlackStart, "spawnKey" | "binding" | "thread" | "request">, reason: string, deps: Pick<MissionSlackDeps, "queue">): Promise<boolean> {
  if (!start.thread) return false;
  const text = `:warning: A Ship couldn't start for this request. ${refusalSaid(reason)} The work isn't lost: the Mission's owner can sort it out in Outrunner, and you can ask again.`;
  const outcome = await deps.queue(
    postIn(start.binding, start.thread, {
      // Keyed by the start, as limit: is, not the reservation: a refusal
      // gives its reservation back, so a retry gets a new one.
      opKey: `refused:${start.binding.missionId}:${start.request?.requestKey ?? start.thread.threadTs}:${start.spawnKey}`,
      kind: "card",
      payload: { chunks: [text] },
      requester: start.request?.requestedBy ?? start.thread.startedBy,
    }),
  );
  return outcome === "queued";
}

/** Run one of the Slack tools for the Mission. */
export async function callSlackTool(mission: Workspace, name: string, args: Record<string, unknown>, deps: MissionSlackDeps | undefined): Promise<ToolResult> {
  if (!deps) return refuse(NOT_ON_CALL);
  const scoped = await scopedThread(mission, args.thread, deps);
  if ("error" in scoped) return refuse(scoped.error);
  const { binding, thread } = scoped;
  const latest = await deps.latestRequest(thread.id);
  // Whose request a post answers: their access is checked again before it goes.
  const requester = latest?.requestedBy ?? thread.startedBy;
  const about = latest?.requestKey ?? "-";
  const queued = (outcome: QueueOutcome, what: string): ToolResult => {
    switch (outcome) {
      case "queued":
        return { text: `Queued: the ${what} posts in the thread shortly.` };
      case "already_pending":
        return { text: `Already queued (the same ${what}): it isn't posted twice.` };
      case "already_sent":
        return { text: `Already posted (the same ${what}): it isn't posted twice. Use post_key for a deliberate repeat.` };
      case "ambiguous":
        return {
          text: `The same ${what} went unanswered by Slack earlier, and whether it posted couldn't be told, so it isn't posted again. Check the thread, or use post_key to post it anew.`,
          isError: true,
        };
    }
  };
  switch (name) {
    case "slack_reply": {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text) return refuse("text is required.");
      if (text.length > 12000) return refuse("That's too long for a thread: keep it under 12000 characters.");
      if (given(args.post_key) && (typeof args.post_key !== "string" || !POST_KEY_PATTERN.test(args.post_key))) {
        return refuse("post_key is up to 80 letters, digits, . _ : or -.");
      }
      const key = typeof args.post_key === "string" ? `k:${args.post_key}` : `h:${about}:${hash(text)}`;
      const outcome = await deps.queue(
        postIn(binding, thread, {
          opKey: `reply:${mission.id}:${thread.threadTs}:${key}`,
          kind: "reply",
          // No channel-wide pings from what the Mission writes (it reads text from outside).
          payload: { chunks: slackChunks(quietText(markdownToSlack(text)), 3500) },
          requester,
        }),
      );
      return queued(outcome, "reply");
    }
    case "slack_ask": {
      const question = typeof args.question === "string" ? args.question.trim() : "";
      const options = Array.isArray(args.options)
        ? [...new Set(args.options.flatMap((o) => (typeof o === "string" && o.trim() ? [o.trim().slice(0, 75)] : [])))]
        : [];
      if (!question || question.length > 2900) return refuse("question is required, up to 2900 characters.");
      if (options.length < 1 || options.length > 5) return refuse("Give 1 to 5 options.");
      const opKey = `ask:${mission.id}:${binding.revision}:${thread.threadTs}:${about}:${hash(question, ...options)}`;
      const askId = await deps.saveAsk({ missionId: mission.id, threadId: thread.id, question, options, opKey, bindingRevision: binding.revision });
      const outcome = await deps.queue(
        postIn(binding, thread, { opKey, kind: "ask", payload: { text: quietText(question), blocks: deps.askBlocks(askId, quietText(question), options), askId }, requester }),
      );
      const said = queued(outcome, "question card");
      return said.isError ? said : { text: `${said.text} The first answer comes back to you as a <slack_answer> block; end your turn until then.` };
    }
    case "slack_react": {
      const emoji = typeof args.emoji === "string" ? reactionName(args.emoji) : null;
      if (!emoji) return refuse('emoji is one of "eyes", "white_check_mark" or "x".');
      let ts = latest?.messageTs ?? thread.lastRequestTs ?? thread.threadTs;
      if (given(args.request_id)) {
        const request = typeof args.request_id === "string" ? await deps.request(mission.id, args.request_id) : null;
        if (!request || request.threadId !== thread.id || !request.messageTs) return refuse(NO_SUCH_REQUEST);
        ts = request.messageTs;
      }
      const outcome = await deps.queue(
        postIn(binding, thread, { opKey: `react:${mission.id}:${binding.channelId}:${ts}:${emoji}`, kind: "reaction", payload: { ts, name: emoji }, requester }),
      );
      return queued(outcome, "reaction");
    }
    default:
      return refuse(`No tool is called ${name}.`);
  }
}

/** A Ship start on call, prepared: its reservation (place, key, the session
 *  id it gets), and what its brief says of who asked. */
export type SlackStart = {
  reservation: string;
  /** The Mission's name for this start: a retry uses it again. */
  spawnKey: string;
  plannedRunnerId: string;
  /** Reserved by an earlier call that never made its Ship: resumed. */
  resumed: boolean;
  binding: MissionChannel;
  thread: MissionThread | null;
  request: MissionRequest | null;
  briefNote: string | null;
};

/** Why a Ship start, or a message for a Ship, may not go ahead now; null
 *  when it may. Checked right before acting: the binding still the same
 *  (and not paused, for a start), the thread not muted, and the requester
 *  still able to read the project. */
export async function recheckStart(mission: Workspace, start: Pick<SlackStart, "binding" | "thread" | "request">, deps: MissionSlackDeps): Promise<string | null> {
  const binding = await deps.binding(mission.id);
  if (!binding || binding.revision !== start.binding.revision) return "the Mission is no longer on call in that channel (or was put on call again since)";
  if (binding.paused) return "the Mission is paused in Slack: start nothing new until someone says @Outrunner resume";
  if (start.thread) {
    const thread = await deps.threadById(start.thread.id);
    if (!thread || thread.missionId !== mission.id) return "the thread is no longer this Mission's";
    if (thread.muted) return "the thread is muted";
  }
  if (start.request?.requestedBy && !(await deps.canRead(start.request.requestedBy, mission))) {
    return "the person who asked can no longer read this project";
  }
  return null;
}

/**
 * For spawn_runner on a Mission on call: reserve the start under its key,
 * after checking it may go. Null when the Mission isn't on call (and no
 * request was named): spawn_runner goes on as for any Mission. `existing`
 * when the key's Ship was made already.
 */
export async function slackSpawn(
  mission: Workspace,
  args: Record<string, unknown>,
  deps: MissionSlackDeps | undefined,
  sessionExists: (id: string) => Promise<boolean>,
): Promise<null | { error: string } | { existing: string } | SlackStart> {
  if (!deps) return given(args.request_id) || given(args.thread) ? { error: NOT_ON_CALL } : null;
  const binding = await deps.binding(mission.id);
  if (!binding) return given(args.request_id) || given(args.thread) ? { error: NOT_ON_CALL } : null;
  const spawnKey = typeof args.spawn_key === "string" ? args.spawn_key.trim() : "";
  if (!SPAWN_KEY.test(spawnKey)) {
    return {
      error:
        'spawn_key is required while on call: a short stable name for this Ship start (letters, digits, . _ : -), e.g. "fix-login". Use the same one to retry a start, a new one for each distinct Ship.',
    };
  }

  // The request it's for: named, or a thread's latest.
  let request: MissionRequest | null = null;
  let thread: MissionThread | null = null;
  if (given(args.request_id)) {
    request = typeof args.request_id === "string" ? await deps.request(mission.id, args.request_id.trim()) : null;
    thread = request?.threadId ? await deps.threadById(request.threadId) : null;
    if (!request || !thread || !inChannel(thread, mission, binding)) return { error: NO_SUCH_REQUEST };
    if (given(args.thread) && args.thread !== thread.threadTs) return { error: "request_id and thread name different threads." };
  } else if (given(args.thread)) {
    const scoped = await scopedThread(mission, args.thread, deps);
    if ("error" in scoped) return { error: scoped.error };
    thread = scoped.thread;
    request = await deps.latestRequest(thread.id);
  }
  if (request?.bindingRevision && request.bindingRevision !== binding.revision) {
    return { error: "That request came in before the Mission was put on call again: ask the requester to mention Outrunner again." };
  }
  const why = await recheckStart(mission, { binding, thread, request }, deps);
  if (why) return { error: `The Ship didn't start: ${why}.` };

  const reserved = await deps.reserveSpawn({
    missionId: mission.id,
    requestKey: request?.requestKey ?? null,
    spawnKey,
    threadId: thread?.id ?? null,
    requester: request?.requestedBy ?? null,
    requesterSlack: request?.requestedBySlack ?? null,
    revision: binding.revision,
  });
  if ("refused" in reserved) {
    if (thread) {
      await deps
        .queue(
          postIn(binding, thread, {
            opKey: `limit:${mission.id}:${request?.requestKey ?? thread.threadTs}:${spawnKey}`,
            kind: "reply",
            payload: { chunks: [limitText(reserved.refused, reserved.limit)] },
            requester: request?.requestedBy ?? null,
          }),
        )
        .catch(() => "already_pending" as const);
    }
    return {
      error: `The Ship didn't start: this Mission reached its limit on Ships started while on call (${reserved.limit} ${
        reserved.refused === "hour" ? "in an hour" : "in 24 hours"
      }).${thread ? " The thread is told; start nothing more for it." : " Tell the requester in their thread, and start nothing."}`,
    };
  }
  if (reserved.runnerId) return { existing: reserved.runnerId };
  if (reserved.existing && (await sessionExists(reserved.plannedRunnerId))) {
    // Made by an earlier call that never heard back: that's the Ship.
    await deps.linkShip(reserved.id, reserved.plannedRunnerId);
    return { existing: reserved.plannedRunnerId };
  }

  let briefNote: string | null = null;
  if (request) {
    const who = await deps.requesterName(request, thread).catch(() => ({ name: "someone", permalink: thread?.permalink ?? null }));
    briefNote = `\n\n---\nRequested in Slack by ${who.name}${who.permalink ? ` (${who.permalink})` : ""}. In your pull request's description, say: "Requested by ${who.name} in Slack."`;
  }
  return { reservation: reserved.id, spawnKey, plannedRunnerId: reserved.plannedRunnerId, resumed: reserved.existing, binding, thread, request, briefNote };
}

/** For message_runner: a Ship started for a Slack request is messaged only
 *  while the binding it came in under stands and its requester can read
 *  the project. A paused Mission still steers work it started (decision 3),
 *  and a muted thread is about Slack, not the Ship. Null when it may. */
export async function recheckMessage(mission: Workspace, runnerId: string, deps: MissionSlackDeps | undefined): Promise<string | null> {
  if (!deps) return null;
  const ledger = await deps.ledger(runnerId);
  if (!ledger?.requestKey) return null;
  const binding = await deps.binding(mission.id);
  if (!binding || (ledger.bindingRevision && binding.revision !== ledger.bindingRevision)) {
    return "That Ship was started for a Slack request under a binding that has ended (the Mission went off call, or was put on call again). Its owner can carry on with it in Outrunner.";
  }
  if (ledger.requestedBy && !(await deps.canRead(ledger.requestedBy, mission))) {
    return "That Ship was started for someone who can no longer read this project, so it takes no more messages from you. Its owner can carry on with it in Outrunner.";
  }
  return null;
}
