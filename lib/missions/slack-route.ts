/**
 * Slack → a Mission on call (docs/missions.md, "On call in Slack"): the first
 * thing the Slack agent asks of a message (lib/slack/agent-run.ts). In a
 * channel a Mission is bound to, a mention of Outrunner, or a reply in a
 * thread the Mission took, skips the spec-card flow and goes to the Mission
 * as a `slack_request` in its outbox, which wakes it or folds into its turn,
 * once (its key is Slack's event id). Anything else goes on to the agent as
 * before.
 *
 * Before anything reaches the Mission, here, by rule rather than a model:
 *
 *   commands  `be on call here for <project>`, `stop being on call here`,
 *             `pause`, `resume`, `stop` (its turn), exact, on a mention
 *   keywords  `!aside` (ignored), `!mute` / `!unmute` (the thread),
 *             `!help`, `!new <task>` (a fresh thread), `!assign @person`
 *   gate      a linked Outrunner account in the Mission's org that can read
 *             its project; anyone else is asked to connect, or refused
 *   paused    says so, and takes nothing
 *   budget    the Mission's budget reached: one fixed reply, takes nothing
 *   bots      the bot's own messages never; other bots' only with
 *             allow_bot_messages, when they mention Outrunner, vouched for
 *             by whoever bound the channel
 *   idle      a human message meant for the Mission (a mention, a reply in
 *             its unmuted thread or under its idle offer; linked or not,
 *             paused or not; never `!aside`) moves its last human reply and
 *             calls off an idle offer (lib/missions/idle-pause.ts)
 *
 * What touches the world comes in as `deps` (slack-route.deps.ts).
 */

import { eventKey, type SlackEventPayload } from "@/lib/missions/events";
import type { MissionChannel, MissionRequest, MissionThread, BindOutcome } from "@/lib/missions/slack-store";
import {
  ASSIGN_ELSEWHERE,
  ASSIGN_USAGE,
  assignTarget,
  assignedNote,
  assignedText,
  assigneeNotLinkedText,
  budgetReachedText,
  NEW_KEY_PREFIX,
  NEW_USAGE,
  newTask,
  ON_CALL_HELP,
  onCallCommand,
  threadKeyword,
  withoutMention,
  type OnCallCommand,
} from "@/lib/missions/slack-text";
import type { RecordedEvent } from "@/lib/missions/watch";
import { allows, type AccessLevel } from "@/lib/orgs/access";
import type { Workspace } from "@/lib/runtime/types";

/** A message, as the Slack agent's events endpoint passes it on. */
export type SlackRouteMessage = {
  teamId: string;
  channel: string;
  channelType?: string | null;
  user: string;
  text: string;
  ts: string;
  threadTs?: string | null;
  mention: boolean;
  /** Slack's id for the event: the request's idempotency key. */
  eventId?: string | null;
  /** A bot's message: its bot id. */
  botId?: string | null;
  /** Its files' names. */
  files?: string[];
};

/** A linked Outrunner account: who's asking, in which org. */
export type Requester = { userId: string; orgId: string };

/** A project (an `environments` row) a bind names. */
export type FoundProject = { id: string; name: string };

export type SlackRouteDeps = {
  botUserId: string;
  binding(teamId: string, channel: string): Promise<MissionChannel | null>;
  thread(teamId: string, channel: string, threadTs: string): Promise<MissionThread | null>;
  mission(id: string): Promise<Workspace | null>;
  /** The sender's linked, active account; null when they have none. */
  linked(slackUserId: string): Promise<Requester | null>;
  /** `!new <task>`: record a fresh request and queue its root post in the
   *  bound channel (lib/missions/requests.ts newThreadRequest). */
  newThreadRequest(input: {
    missionId: string;
    key: string;
    task: string;
    requestedBy: string;
    requestedBySlack: string;
    author: string;
  }): Promise<"queued" | "off_call">;
  /** `!assign @person`: the thread's open requests assigned to them. How many. */
  assignThread(input: { missionId: string; threadId: string; assignee: string; by: string }): Promise<number>;
  /** Their level on the Mission's project. */
  level(userId: string, mission: Workspace): Promise<AccessLevel | null>;
  /** The Mission's project's name, for what's said in Slack. */
  projectName(mission: Workspace): Promise<string>;
  acceptThread(input: {
    missionId: string;
    threadTs: string;
    requestTs: string;
    permalink: string | null;
    startedBy: string | null;
    startedBySlack: string | null;
  }): Promise<MissionThread>;
  /** Claim the Slack message for this request: one message is one request
   *  anywhere (a watch may hear the same channel). False: another has it. */
  claimMessage?(ts: string, missionId: string, requestKey: string): Promise<boolean>;
  /** Record the request, once (its key is the Slack event's). */
  recordRequest(request: MissionRequest): Promise<unknown>;
  setMuted(threadId: string, muted: boolean): Promise<void>;
  setPaused(missionId: string, paused: boolean): Promise<void>;
  /** Take the Mission off call here, and tell it. */
  unbind(binding: MissionChannel, by: Requester): Promise<void>;
  /** The Mission's budget pause, if it's budget-paused (budget.deps.ts):
   *  the period reached. */
  budgetPause?(missionId: string): Promise<"day" | "week" | null>;
  /** Record an event for the Mission: true when it's new. */
  enqueue(event: RecordedEvent): Promise<boolean>;
  /** Stop this thread's work: its open requests cancelled and its Ships'
   *  running turns interrupted (lib/missions/requests.ts stopThreadWork),
   *  no other thread's. */
  stopThread(mission: Workspace, threadId: string): Promise<{ requests: number; ships: number }>;
  /** A human posted something the Mission hears (lib/missions/idle-pause.ts). */
  heardHuman?(binding: MissionChannel): Promise<void>;
  /** Whether the thread is the binding's idle offer, as posted. */
  idleOfferThread?(binding: MissionChannel, threadTs: string): Promise<boolean>;
  /** A Slack user's name, as Slack shows it. */
  name(slackUserId: string): Promise<string>;
  permalink(ts: string): Promise<string | null>;
  /** Say it in the thread, for all. */
  reply(threadTs: string, text: string): Promise<void>;
  /** Say it to the sender alone. */
  tell(threadTs: string, text: string): Promise<void>;
  askToConnect(threadTs: string): Promise<void>;
  // The bind command's.
  /** The project they named, among those they can see in their org. */
  findProject(requester: Requester, name: string): Promise<FoundProject | { ambiguous: string[] } | null>;
  projectLevel(userId: string, projectId: string): Promise<AccessLevel | null>;
  /** A local channel with Outrunner in it (not Slack Connect or shared). */
  localChannel(): Promise<boolean>;
  /** Their own Missions on the project that aren't on call anywhere, newest first. */
  freeMissions(userId: string, projectId: string): Promise<Workspace[]>;
  createMission(requester: Requester, project: FoundProject): Promise<{ missionId: string } | { error: string }>;
  bind(input: { missionId: string; orgId: string; boundBy: string }): Promise<BindOutcome>;
  /** Tell the Mission it's on call, post its intro, and audit it. */
  announce(binding: MissionChannel, mission: Workspace, project: string, by: Requester): Promise<void>;
};

/** The most of a request's text the Mission is handed. */
export const REQUEST_MAX_CHARS = 8000;

const GONE: readonly string[] = ["destroying", "destroyed"];
const PUT_AWAY: readonly string[] = ["archiving", "archived"];

/**
 * The message, if it's a Mission's to handle: true when it was (taken,
 * refused, or a command done), false for the Slack agent to go on with.
 */
export async function routeToMission(message: SlackRouteMessage, deps: SlackRouteDeps): Promise<boolean> {
  if (message.user === deps.botUserId) return false;
  if (message.channelType === "im" || !/^[CG]/.test(message.channel)) return false;
  const command = message.mention && !message.botId ? onCallCommand(message.text, deps.botUserId) : null;
  const threadTs = message.threadTs ?? message.ts;
  const binding = await deps.binding(message.teamId, message.channel);
  if (command?.action === "bind") {
    if (binding) await heard(binding, deps);
    await bindHere(command.project, message, binding, deps);
    return true;
  }
  if (!binding) {
    // `stop` in a channel with no Mission is the Slack agent's (a session's
    // turn); the rest are about a Mission there isn't.
    if (command && command.action !== "stop") {
      await deps.reply(threadTs, command.action === "help" ? ON_CALL_HELP : `No Mission is on call here. ${ON_CALL_HELP}`);
      return true;
    }
    return false;
  }

  const thread = message.threadTs ? await deps.thread(message.teamId, message.channel, message.threadTs) : null;
  const owned = thread !== null && thread.missionId === binding.missionId;
  // A human reply (lib/missions/idle-pause.ts) is one meant for the
  // Mission: a mention, or a reply in a thread of its that isn't muted, or
  // under its idle offer. `!aside` and a muted thread are people talking to
  // each other.
  const aside = threadKeyword(withoutMention(message.text, deps.botUserId)) === "aside";
  if (!message.botId && !aside && !(owned && thread.muted)) {
    if (message.mention || owned) await heard(binding, deps);
    // A reply under its idle offer answers it: heard, and the Mission's.
    else if (message.threadTs && binding.idleWarnedAt && (await offerThread(binding, message.threadTs, deps))) {
      await heard(binding, deps);
      return true;
    }
  }
  // v1 listens to mentions and its own threads only (listen = 'mentions').
  if (!message.mention && !owned) return false;
  // A bot is heard only when the channel takes bots' messages, and only
  // when it mentions Outrunner: never a reply in a thread, so the bot's own
  // posts there can't come back as requests, whatever Slack says of them.
  if (message.botId && (!binding.allowBotMessages || !message.mention)) return true;

  // Neither needs who's speaking: dropped quietly, before the gate, so
  // someone unlinked isn't told off on every reply in a busy thread.
  const text = withoutMention(message.text, deps.botUserId);
  // `!help`, `!new` and `!assign` are people's: a bot's are its text.
  const typed = threadKeyword(text);
  const keyword = message.botId && (typed === "help" || typed === "new" || typed === "assign") ? null : typed;
  if (keyword === "aside") return true;
  if (owned && thread.muted && !message.mention && keyword !== "unmute") return true;
  if (keyword === "help") {
    await deps.tell(threadTs, ON_CALL_HELP);
    return true;
  }

  // A bot is vouched for by whoever put the Mission on call here.
  const requester = message.botId
    ? binding.boundBy
      ? { userId: binding.boundBy, orgId: binding.orgId }
      : null
    : await deps.linked(message.user);
  // Refusals go to someone who asked (a mention); a plain thread reply that
  // doesn't pass is dropped quietly.
  const refuse = async (said: string) => {
    if (message.mention && !message.botId) await deps.tell(threadTs, said);
  };
  if (!requester) {
    if (message.mention && !message.botId) await deps.askToConnect(threadTs);
    return true;
  }
  if (requester.orgId !== binding.orgId) {
    await refuse("Your Slack account is connected to a different Outrunner org than the Mission on call here.");
    return true;
  }
  const mission = await deps.mission(binding.missionId);
  if (!mission || mission.kind !== "mission" || GONE.includes(mission.status)) {
    await deps.reply(threadTs, "The Mission that was on call here is gone. Someone with write on its project can put another on call.");
    return true;
  }
  const level = await deps.level(requester.userId, mission);
  const project = await deps.projectName(mission);
  if (!allows(level, "read")) {
    await refuse(`Only people who can read ${project} in Outrunner can give the Mission on call here work.`);
    return true;
  }

  if (keyword === "mute" || keyword === "unmute") {
    if (!thread || !owned) {
      await deps.tell(threadTs, `\`!${keyword}\` works in a thread the Mission is in.`);
      return true;
    }
    await deps.setMuted(thread.id, keyword === "mute");
    await deps.reply(
      threadTs,
      keyword === "mute"
        ? "Muted: the Mission won't read or post in this thread until someone says `!unmute`."
        : "Unmuted: the Mission hears this thread again.",
    );
    return true;
  }
  if (owned && thread.muted) {
    if (message.mention) await deps.tell(threadTs, "This thread is muted. Say `!unmute` first.");
    return true;
  }

  if (command) {
    await runCommand(command, { binding, mission, project, requester, level, threadTs }, deps);
    return true;
  }
  if (binding.paused) {
    const said = `The Mission on call here is paused, so it didn't take that. Someone with write on ${project} can say \`@Outrunner resume\`.`;
    await (message.mention ? deps.reply(threadTs, said) : deps.tell(threadTs, said));
    return true;
  }
  if (PUT_AWAY.includes(mission.status)) {
    const said = "The Mission on call here is archived, so it didn't take that. Its owner can open it in Outrunner to bring it back.";
    await (message.mention ? deps.reply(threadTs, said) : deps.tell(threadTs, said));
    return true;
  }
  if (keyword === "new") {
    await newThread(newTask(text), { message, mission, requester }, deps);
    return true;
  }
  if (keyword === "assign") {
    await assign(text, { message, binding, mission, requester, thread: owned ? thread : null, threadTs }, deps);
    return true;
  }
  if (!text && !message.files?.length) {
    if (message.mention) await deps.tell(threadTs, "Mention me with a task, and the Mission on call here takes it on.");
    return true;
  }
  const budget = deps.budgetPause ? await deps.budgetPause(mission.id) : null;
  if (budget) {
    // Nothing recorded, nothing for the Mission: as a pause, said once.
    const said = budgetReachedText(budget);
    await (message.mention ? deps.reply(threadTs, said) : deps.tell(threadTs, said));
    return true;
  }

  const permalink = await deps.permalink(message.ts).catch(() => null);
  const requestKey = message.eventId ?? `${message.teamId}:${message.channel}:${message.ts}`;
  if (deps.claimMessage && !(await deps.claimMessage(message.ts, mission.id, requestKey))) return true;
  const accepted = await deps.acceptThread({
    missionId: mission.id,
    threadTs,
    requestTs: message.ts,
    permalink: thread?.permalink ?? (message.threadTs ? await deps.permalink(message.threadTs).catch(() => null) : permalink),
    startedBy: requester.userId,
    startedBySlack: message.botId ? null : message.user,
  });
  // Saved before the Mission hears of it: its Ships and their pull requests
  // are tracked by it, and who asked is rechecked by it before acting.
  await deps.recordRequest({
    missionId: mission.id,
    requestKey,
    threadId: accepted.id,
    bindingRevision: binding.revision,
    messageTs: message.ts,
    requestedBy: requester.userId,
    requestedBySlack: message.botId ? null : message.user,
  });
  const slack: SlackEventPayload = {
    channel: message.channel,
    thread: threadTs,
    request: requestKey,
    ts: message.ts,
    permalink,
    author: message.botId ? `a bot (${message.botId})` : await deps.name(message.user),
    slackUserId: message.user,
    userId: requester.userId,
    text: text.slice(0, REQUEST_MAX_CHARS),
    ...(message.files?.length && { files: message.files.slice(0, 20) }),
  };
  await deps.enqueue({
    missionId: mission.id,
    runnerId: null,
    kind: "slack_request",
    payload: { slack },
    key: eventKey.slackRequest(requestKey),
  });
  return true;
}

/** A human was heard: never in the way of the message, whatever fails. */
async function heard(binding: MissionChannel, deps: SlackRouteDeps): Promise<void> {
  await deps.heardHuman?.(binding).catch((error: unknown) => console.error(`Mission ${binding.missionId}: couldn't note a human reply`, error));
}

async function offerThread(binding: MissionChannel, threadTs: string, deps: SlackRouteDeps): Promise<boolean> {
  if (!deps.idleOfferThread) return false;
  return deps.idleOfferThread(binding, threadTs).catch(() => false);
}

/** `!new <task>`: a fresh request in a new thread of the bound channel, by
 *  the same gate as any request (passed by now). Nothing of the thread it
 *  was typed in goes with it. */
async function newThread(
  task: string,
  at: { message: SlackRouteMessage; mission: Workspace; requester: Requester },
  deps: SlackRouteDeps,
): Promise<void> {
  const { message, mission, requester } = at;
  const threadTs = message.threadTs ?? message.ts;
  if (!task) {
    await deps.tell(threadTs, NEW_USAGE);
    return;
  }
  const key = `${NEW_KEY_PREFIX}${message.eventId ?? `${message.teamId}:${message.channel}:${message.ts}`}`;
  if (deps.claimMessage && !(await deps.claimMessage(message.ts, mission.id, key))) return;
  const outcome = await deps.newThreadRequest({
    missionId: mission.id,
    key,
    task: task.slice(0, REQUEST_MAX_CHARS),
    requestedBy: requester.userId,
    requestedBySlack: message.user,
    author: await deps.name(message.user),
  });
  if (outcome === "off_call") await deps.tell(threadTs, "The Mission went off call here, so it didn't take that.");
}

/** `!assign @person` in one of the Mission's threads: its open requests
 *  (and so their Ships) assigned to someone with an Outrunner account in
 *  the Mission's org. Nothing stops: the Mission keeps working, its Ships
 *  still run as its owner, and it's told in a note. */
async function assign(
  text: string,
  at: { message: SlackRouteMessage; binding: MissionChannel; mission: Workspace; requester: Requester; thread: MissionThread | null; threadTs: string },
  deps: SlackRouteDeps,
): Promise<void> {
  const { message, binding, mission, requester, thread, threadTs } = at;
  if (!thread) {
    await deps.tell(threadTs, ASSIGN_ELSEWHERE);
    return;
  }
  const slackUserId = assignTarget(text);
  if (!slackUserId) {
    await deps.tell(threadTs, ASSIGN_USAGE);
    return;
  }
  const assignee = await deps.linked(slackUserId);
  if (!assignee || assignee.orgId !== binding.orgId) {
    await deps.tell(threadTs, assigneeNotLinkedText(slackUserId, assignee !== null));
    return;
  }
  const assigned = await deps.assignThread({ missionId: mission.id, threadId: thread.id, assignee: assignee.userId, by: requester.userId });
  if (assigned === 0) {
    await deps.tell(threadTs, "Nothing is open in this thread to assign.");
    return;
  }
  const [name, by] = await Promise.all([deps.name(slackUserId), deps.name(message.user)]);
  await deps.reply(threadTs, assignedText(name));
  const key = message.eventId ?? `${message.teamId}:${message.channel}:${message.ts}`;
  await deps.enqueue({
    missionId: mission.id,
    runnerId: null,
    kind: "slack_request",
    payload: {
      slack: {
        channel: message.channel,
        thread: threadTs,
        ts: message.ts,
        author: "Outrunner",
        text: assignedNote(name, by),
      },
    },
    key: eventKey.slackRequest(`assign:${key}`),
  });
}

async function runCommand(
  command: Exclude<OnCallCommand, { action: "bind" }>,
  at: { binding: MissionChannel; mission: Workspace; project: string; requester: Requester; level: AccessLevel | null; threadTs: string },
  deps: SlackRouteDeps,
): Promise<void> {
  const { binding, mission, project, requester, level, threadTs } = at;
  switch (command.action) {
    case "help":
      await deps.reply(threadTs, ON_CALL_HELP);
      return;
    case "stop": {
      const thread = await deps.thread(binding.teamId, binding.channelId, threadTs);
      const stopped = thread && thread.missionId === mission.id ? await deps.stopThread(mission, thread.id).catch(() => null) : { requests: 0, ships: 0 };
      const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
      await deps.reply(
        threadTs,
        stopped === null
          ? "I couldn't reach the Mission to stop this thread's work."
          : stopped.requests === 0 && stopped.ships === 0
            ? "Nothing is open in this thread."
            : `Stopped: ${plural(stopped.requests, "request", "requests")} cancelled and ${plural(stopped.ships, "Ship's turn", "Ships' turns")} interrupted. The Mission archives the Ships with no open pull request and starts nothing more for these requests. Other threads go on.`,
      );
      return;
    }
    case "pause":
    case "resume":
    case "unbind": {
      if (!allows(level, "write")) {
        await deps.tell(threadTs, `That needs write on ${project} in Outrunner.`);
        return;
      }
      if (command.action === "unbind") {
        await deps.unbind(binding, requester);
        await deps.reply(threadTs, `The Mission is off call here. Mentions go to the Outrunner agent again.`);
        return;
      }
      const paused = command.action === "pause";
      await deps.setPaused(binding.missionId, paused);
      await deps.reply(
        threadTs,
        paused
          ? "Paused: the Mission takes nothing from this channel until someone says `@Outrunner resume`. Work it already started goes on."
          : "Resumed: mention me with a task, and the Mission on call here takes it on.",
      );
      return;
    }
  }
}

/** `be on call here for <project>`: bind one of the sender's Missions on that
 *  project (the newest not on call elsewhere), or start one. Needs write on
 *  the project, and a local channel. */
async function bindHere(name: string, message: SlackRouteMessage, binding: MissionChannel | null, deps: SlackRouteDeps): Promise<void> {
  const threadTs = message.threadTs ?? message.ts;
  const requester = await deps.linked(message.user);
  if (!requester) {
    await deps.askToConnect(threadTs);
    return;
  }
  if (binding) {
    const current = await deps.mission(binding.missionId);
    await deps.reply(
      threadTs,
      `${current?.title ? `Mission "${current.title}"` : "A Mission"} is on call here already. To change it: \`@Outrunner stop being on call here\`, then try again.`,
    );
    return;
  }
  if (!(await deps.localChannel())) {
    await deps.reply(threadTs, "A Mission goes on call only in this workspace's own channels, with Outrunner added. Slack Connect and shared channels aren't supported.");
    return;
  }
  const found = await deps.findProject(requester, name);
  if (!found) {
    await deps.reply(threadTs, `I couldn't find a project called "${name.replace(/[<>]/g, "")}" that you can see in Outrunner.`);
    return;
  }
  if ("ambiguous" in found) {
    await deps.reply(threadTs, `Several projects match "${name.replace(/[<>]/g, "")}": ${found.ambiguous.join(", ")}. Name one exactly.`);
    return;
  }
  if (!allows(await deps.projectLevel(requester.userId, found.id), "write")) {
    await deps.tell(threadTs, `Putting a Mission on call needs write on ${found.name} in Outrunner.`);
    return;
  }
  let missionId = (await deps.freeMissions(requester.userId, found.id))[0]?.id ?? null;
  if (!missionId) {
    const created = await deps.createMission(requester, found);
    if ("error" in created) {
      await deps.reply(threadTs, `The Mission didn't start: ${created.error}`);
      return;
    }
    missionId = created.missionId;
  }
  const outcome = await deps.bind({ missionId, orgId: requester.orgId, boundBy: requester.userId });
  if (outcome !== "bound") {
    await deps.reply(
      threadTs,
      outcome === "channel_taken" ? "Another Mission went on call here just now." : "That Mission is on call in another channel already.",
    );
    return;
  }
  const mission = await deps.mission(missionId);
  const bound = await deps.binding(message.teamId, message.channel);
  if (mission && bound) await deps.announce(bound, mission, found.name, requester);
}
