/**
 * The Slack agent at work: a turn of the conversation when someone mentions
 * Outrunner or replies in its thread, and what its spec card's buttons do.
 * Each runs after Slack has had its answer (Slack waits 3 seconds), so it
 * reports what happened in the thread itself.
 *
 *   coordinator - this agent: asks, then proposes a spec with acceptance
 *                 criteria and a session prompt (lib/slack/agent.ts)
 *   worker      - a cloud session a person starts from the card
 *                 (startServerSession), told to open a PR naming the item
 *   validator   - the "Validate against acceptance criteria" automation on
 *                 that PR (lib/automations/templates.ts)
 */

import { isOwner } from "@/lib/auth/allowlist";
import { listOrgProjects } from "@/lib/db/org-access";
import {
  sessionSummary,
  conversationForItem,
  getConversation,
  getConversationById,
  getInstallation,
  openConversation,
  orgModelKey,
  watchModelKey,
  forgetWatchModelKey,
  type SlackConversation,
  type SlackInstallation,
  updateConversation,
} from "@/lib/db/slack-agent";
import { slackLinkTarget } from "@/lib/db/slack-links";
import {
  addNote,
  captureWorkItem,
  getWorkItem,
  linkWorkItemToSession,
  openItemTitles,
  resolveProject,
  setWorkItemPrompt,
  triageActor,
} from "@/lib/db/work-items";
import { optionalEnv } from "@/lib/env";
import { ModelKeyDisabledError, ModelKeyRefusedError, OutrunnerModelsUnavailableError } from "@/lib/openrouter/keys";
import { startServerSession } from "@/lib/session/server-session";
import {
  type AgentSpec,
  filedCard,
  parseAgentReply,
  SPEC_ACTIONS,
  specCard,
  specMarkdown,
  specSummary,
  systemPrompt,
  transcript,
  workerPrompt,
} from "@/lib/slack/agent";
import { agentTurn, type Lookups, oneShot } from "@/lib/slack/agent-model";
import { findItems, itemStatus, recentWork } from "@/lib/slack/lookups";
import { askResearch, wakeAndSend } from "@/lib/slack/research";
import { awaitReply, fromThread, sendToSession, stopSession, watchForReply } from "@/lib/slack/relay";
import { channelSettings, setChannelSettings } from "@/lib/db/slack-channels";
import { githubGet, repoToken } from "@/lib/slack/github";
import { threadSession } from "@/lib/slack/proactive";
import {
  CLASSIFIER_PROMPT,
  isTimeZone,
  parseClassification,
  PROACTIVE_ACTIONS,
  sendBackPrompt,
  watchOffer,
} from "@/lib/slack/proactive-text";
import { canTriage } from "@/lib/triage/access";
import { signLinkToken, slackPermalink, slackToMarkdown } from "@/lib/slack/slack";
import {
  addReaction,
  deleteMessage,
  postEphemeral,
  postMessage,
  removeReaction,
  threadReplies,
  updateMessage,
  userNames,
} from "@/lib/slack/web";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { TriageActor } from "@/lib/triage/access";
import { itemUrl } from "@/lib/triage/urls";
import { itemKey } from "@/lib/triage/work-items";

/** A message event, as the events endpoint passes it on. */
export type AgentMessage = {
  teamId: string;
  teamDomain?: string | null;
  channel: string;
  channelType?: string | null;
  user: string;
  text: string;
  ts: string;
  threadTs?: string | null;
  /** An @mention of the bot (app_mention), rather than a reply or a DM. */
  mention: boolean;
  /** A new message in a channel, not in a thread: heard only where the
   *  channel is watched. */
  topLevel?: boolean;
};

function appUrl(path: string): string {
  const base = optionalEnv("RUNTIME_BASE_URL");
  try {
    return base ? new URL(path, base).toString() : path;
  } catch {
    return path;
  }
}

/** The Slack user's linked account as a triager in the org their captures go
 *  to; null when they haven't linked (or may no longer sign in). */
async function actorFor(teamId: string, slackUserId: string): Promise<TriageActor | null> {
  const target = await slackLinkTarget(teamId, slackUserId);
  if (!target) return null;
  const { data, error } = await createSupabaseAdminClient().auth.admin.getUserById(target.ownerId);
  if (error || !data.user || !isOwner(data.user)) return null;
  return triageActor(target.ownerId, target.orgId);
}

/** Tell one person, in the thread, to connect their account first. */
async function askToConnect(install: SlackInstallation, message: { channel: string; user: string; threadTs: string }) {
  const secret = optionalEnv("SLACK_SIGNING_SECRET");
  if (!secret) return;
  const link = appUrl(
    `/slack/link?t=${signLinkToken({ teamId: install.teamId, teamName: install.teamName, userId: message.user, userName: null }, secret)}`,
  );
  await postEphemeral(install.botToken, {
    ...message,
    text: `Connect Slack to your Outrunner account first: <${link}|Connect Slack to Outrunner> (valid for 10 minutes). Then mention me again.`,
  });
}

/**
 * A message for the agent: an @mention starts or continues its thread; a
 * reply in a thread it's in, or a DM, continues it. Once the thread's work is
 * filed, what's said there becomes notes on the item.
 */
export async function handleAgentMessage(message: AgentMessage): Promise<void> {
  const install = await getInstallation(message.teamId);
  if (!install) {
    console.error(`Slack agent: no bot token for team ${message.teamId}; install the app again through its install link.`);
    return;
  }
  if (message.user === install.botUserId) return;
  // A channel message mentioning the bot comes as an app_mention too: that
  // one answers.
  if (!message.mention && message.channelType !== "im" && message.text.includes(`<@${install.botUserId}`)) return;
  const threadTs = message.threadTs ?? message.ts;
  const reply = (text: string) => postMessage(install.botToken, { channel: message.channel, threadTs, text });
  if (message.topLevel && !message.mention && message.channelType !== "im") {
    await offerIfWork(install, message).catch((error: unknown) => console.error("Slack agent: watching failed", error));
    return;
  }

  try {
    let conversation = await getConversation(message.teamId, message.channel, threadTs);
    if (!conversation) {
      // Only a mention, or a DM, starts one: other threads aren't the agent's.
      if (!message.mention && message.channelType !== "im") return;
      const starter = await actorFor(message.teamId, message.user);
      if (!starter) {
        await askToConnect(install, { channel: message.channel, user: message.user, threadTs });
        return;
      }
      conversation = await openConversation({
        teamId: message.teamId,
        channelId: message.channel,
        threadTs,
        orgId: starter.orgId,
        startedBy: starter.userId,
      });
    }

    // A thread with a session is the session's (Replicas' way): what's said
    // goes to it, and its reply comes back. `!aside` is for the people
    // there; `stop` interrupts the turn.
    if (conversation.state === "started" && conversation.workspaceId) {
      await toSession(install, conversation, message);
      return;
    }
    if (conversation.state === "filed") {
      // Said in the thread: a note on its item. Said to the agent: answered
      // too (a question about it, or about anything else).
      await noteOnItem(conversation, message);
      if (!message.mention) return;
    }

    await runTurn(install, conversation, message);
  } catch (error) {
    console.error("Slack agent: the turn failed", error);
    await reply("Sorry, something went wrong on my side. Mention me again to retry.").catch(() => undefined);
  }
}

/** A message in a filed thread: a note on its item, by whoever said it. */
async function noteOnItem(conversation: SlackConversation, message: AgentMessage) {
  if (!conversation.itemId || !conversation.startedBy) return;
  const actor = (await actorFor(message.teamId, message.user)) ?? (await triageActor(conversation.startedBy, conversation.orgId));
  if (!actor || actor.orgId !== conversation.orgId) return;
  const item = await getWorkItem(actor, conversation.itemId);
  const body = slackToMarkdown(message.text).trim();
  if (!item || !body) return;
  const names = await getInstallation(message.teamId).then((i) => (i ? userNames(i.botToken, [message.user]) : new Map()));
  await addNote(actor, item, {
    body,
    source: "slack",
    sourceUrl: slackPermalink({
      teamDomain: message.teamDomain ?? null,
      channelId: message.channel,
      ts: message.ts,
      threadTs: conversation.threadTs,
    }),
    author: names.get(message.user) ?? null,
  });
}

/** One turn: read the thread, ask the model, ask or propose in the thread. */
async function runTurn(install: SlackInstallation, conversation: SlackConversation, message: AgentMessage) {
  const { channel } = message;
  const threadTs = conversation.threadTs;
  const reply = (text: string) => postMessage(install.botToken, { channel, threadTs, text });
  const starter = conversation.startedBy ? await triageActor(conversation.startedBy, conversation.orgId) : null;
  if (!starter) {
    await reply("Whoever started this thread is no longer in the Outrunner org, so I can't file from it.");
    return;
  }
  // Lookups and research run as whoever asked, with what they may read. Someone
  // who hasn't connected their account can still help with intake, but gets
  // no lookups.
  const linked = await actorFor(message.teamId, message.user);
  const asker = linked && linked.orgId === conversation.orgId ? linked : null;
  const viewer = asker ?? starter;

  let key: string;
  try {
    key = await orgModelKey(conversation.orgId);
  } catch (error) {
    if (error instanceof OutrunnerModelsUnavailableError) {
      await reply("Outrunner's models aren't set up on this deployment, so I can't think this through yet.");
      return;
    }
    if (error instanceof ModelKeyDisabledError) {
      // Turned off by hand on OpenRouter: no plan would bring it back.
      await reply("Outrunner's models are turned off for this org. Someone at Outrunner has to look into it.");
      return;
    }
    if (error instanceof ModelKeyRefusedError) {
      await reply(
        "This org's allowance on Outrunner's models is used up for now: I share it with its cloud sessions. A bigger plan in Settings → Billing raises it.",
      );
      return;
    }
    throw error;
  }

  const [messages, projects, openItems] = await Promise.all([
    threadReplies(install.botToken, channel, threadTs),
    listOrgProjects(conversation.orgId),
    openItemTitles(conversation.orgId),
  ]);
  const visible = projects.filter((p) => viewer.levels.has(p.id));
  const repos = visible.map((p) => ({ fullName: p.fullName, description: null }));
  const names = await userNames(
    install.botToken,
    messages.flatMap((m) => (m.user && m.user !== install.botUserId ? [m.user] : [])),
  );
  const chat = transcript(
    messages.map((m) => ({ user: m.user, botId: m.bot_id, text: m.text, subtype: m.subtype })),
    { userId: install.botUserId },
    names,
  );
  if (chat.length === 0) return;

  const noAccess = async () => JSON.stringify({ error: "Connect your Slack account to Outrunner to look this up." });
  const lookups: Lookups = asker
    ? {
        recent_work: (args) => recentWork(asker, args),
        find_items: (args) => findItems(asker, args),
        item_status: (args) => itemStatus(asker, args),
        channel_settings: (args) => changeChannel(asker, message, args),
      }
    : { recent_work: noAccess, find_items: noAccess, item_status: noAccess, channel_settings: noAccess };
  const context = { repos, openItems, rounds: conversation.rounds };
  const repoNames = repos.map((r) => r.fullName);
  const call = [{ role: "system" as const, content: systemPrompt(context) }, ...chat];
  let answer = parseAgentReply(await agentTurn(key, call, lookups), repoNames);
  // One more try on an answer that doesn't hold together.
  if (!answer) answer = parseAgentReply(await agentTurn(key, call, lookups), repoNames);
  if (!answer) {
    await reply("I couldn't make sense of that one. Could you say it another way?");
    return;
  }
  const filed = conversation.state === "filed" || conversation.state === "started";
  // `[repo:owner/name]` in the message picks the repository, as Replicas' tag does.
  const tagged = /\[repo:\s*([^\]\s]+)\s*\]/i.exec(message.text)?.[1]?.toLowerCase();
  const taggedRepo = tagged ? repoNames.find((r) => r.toLowerCase() === tagged) : undefined;
  if (answer.action === "propose" && taggedRepo) answer = { ...answer, spec: { ...answer.spec, repo: taggedRepo } };

  switch (answer.action) {
    case "answer":
      await reply(answer.message);
      return;
    case "research": {
      if (!asker) {
        await askToConnect(install, { channel, user: message.user, threadTs });
        return;
      }
      const project = visible.find((p) => p.fullName === answer.repo);
      if (!project) return;
      await reply(answer.message);
      await askResearch({ install, conversation, asker, projectId: project.id, question: answer.question });
      return;
    }
    case "ask":
      await reply(answer.message);
      if (!filed) await updateConversation(conversation.id, { state: "gathering", rounds: conversation.rounds + 1 });
      return;
    case "propose": {
      // A thread's work is filed once; new work starts a new thread.
      if (filed) {
        await reply(`${answer.message}\n\nThis thread's work is filed already: start a new thread with me for this one.`);
        return;
      }
      const ts = await postMessage(install.botToken, {
        channel,
        threadTs,
        text: specSummary(answer.spec),
        blocks: [{ type: "section", text: { type: "mrkdwn", text: answer.message } }, ...specCard(answer.spec, conversation.id, repoNames)],
      });
      await updateConversation(conversation.id, { state: "proposed", proposal: answer.spec, proposalTs: ts });
    }
  }
}

/** A click on the spec card. */
export type CardAction = {
  actionId: string;
  conversationId: string;
  teamId: string;
  teamDomain?: string | null;
  user: string;
  userName?: string | null;
  /** The repository picked in the card's dropdown. */
  selected?: string | null;
};

export async function handleCardAction(action: CardAction): Promise<void> {
  const conversation = await getConversationById(action.conversationId);
  if (!conversation || conversation.teamId !== action.teamId) return;
  const install = await getInstallation(action.teamId);
  if (!install) return;
  const where = { channel: conversation.channelId, threadTs: conversation.threadTs };
  const reply = (text: string) => postMessage(install.botToken, { ...where, text });
  const tellClicker = (text: string) => postEphemeral(install.botToken, { ...where, user: action.user, text });

  try {
    if (action.actionId === SPEC_ACTIONS.refine) {
      if (conversation.state !== "proposed") return;
      await updateConversation(conversation.id, { state: "gathering" });
      await reply("Sure. What should change? Mention me with it.");
      return;
    }
    if (action.actionId === SPEC_ACTIONS.repo) {
      await pickRepo(install, conversation, action);
      return;
    }
    const start = action.actionId === SPEC_ACTIONS.fileStart;
    if (start && !conversation.proposal?.repo && conversation.state === "proposed") {
      await tellClicker("Pick a repository in the card first.");
      return;
    }
    if (action.actionId !== SPEC_ACTIONS.file && !start) return;
    if (conversation.state !== "proposed" || !conversation.proposal) {
      await tellClicker("That proposal is filed already, or was replaced by a newer one.");
      return;
    }
    const actor = await actorFor(action.teamId, action.user);
    if (!actor) {
      await askToConnect(install, { channel: conversation.channelId, user: action.user, threadTs: conversation.threadTs });
      return;
    }
    if (actor.orgId !== conversation.orgId) {
      await tellClicker("Your Slack account is connected to a different Outrunner org than this thread's.");
      return;
    }
    // Claimed before anything is filed: a second click finds it taken.
    await updateConversation(conversation.id, { state: "filed" });
    const filed = await fileSpec(actor, conversation, conversation.proposal, action);
    const by = action.userName ? `@${action.userName}` : `<@${action.user}>`;
    if (conversation.proposalTs) {
      await updateMessage(install.botToken, {
        channel: conversation.channelId,
        ts: conversation.proposalTs,
        text: `Filed as ${filed.key}`,
        blocks: filedCard(conversation.proposal, { key: filed.key, url: filed.url, by, started: start && !!filed.projectId }),
      }).catch((error: unknown) => console.error("Slack agent: couldn't update the card", error));
    }
    if (!start) {
      await reply(`Filed as <${filed.url}|${filed.key}>. Replies here are added to it as notes.`);
      return;
    }
    if (!filed.projectId) {
      await reply(
        `Filed as <${filed.url}|${filed.key}>, but you can't start sessions in ${conversation.proposal.repo ?? "its repository"}, so it waits in triage.`,
      );
      return;
    }
    await startWorker(actor, conversation, filed, reply, { teamDomain: action.teamDomain });
  } catch (error) {
    console.error("Slack agent: the card action failed", error);
    await reply("Sorry, that didn't go through. Try the button again.").catch(() => undefined);
  }
}

type Filed = { id: string; key: string; url: string; projectId: string | null; prompt: string; title: string };

/** The proposal as a work item in triage, with its worker prompt kept on it. */
async function fileSpec(actor: TriageActor, conversation: SlackConversation, spec: AgentSpec, action: CardAction): Promise<Filed> {
  const projectId = spec.repo ? await resolveProject(actor, spec.repo) : null;
  const result = await captureWorkItem(actor, {
    title: spec.title,
    body: specMarkdown(spec),
    projectId,
    source: "slack",
    sourceUrl: slackPermalink({ teamDomain: action.teamDomain ?? null, channelId: conversation.channelId, ts: conversation.threadTs }),
    // The thread's ref: a later shortcut capture from this thread is a note.
    sourceRef: `slack:${conversation.teamId}/${conversation.channelId}/${conversation.threadTs}`,
  });
  const item = result.item;
  const key = itemKey(item);
  const url = itemUrl(item);
  const prompt = workerPrompt(spec, { key, url });
  await setWorkItemPrompt(actor.orgId, item.id, prompt);
  await updateConversation(conversation.id, { state: "filed", itemId: item.id });
  return { id: item.id, key, url, projectId: item.projectId ?? projectId, prompt, title: spec.title };
}

/** The worker: a cloud session, as the person who clicked, on the item's
 *  prompt; the thread hears when it's made and when it's ready. */
async function startWorker(
  actor: TriageActor,
  conversation: SlackConversation,
  filed: Filed,
  reply: (text: string) => Promise<string>,
  thread: { teamDomain?: string | null },
) {
  if (!filed.projectId) return;
  const install = await getInstallation(conversation.teamId);
  const react = (name: string) =>
    install ? addReaction(install.botToken, { channel: conversation.channelId, ts: conversation.threadTs, name }).catch(() => undefined) : undefined;
  await react("eyes");
  const threadUrl = slackPermalink({ teamDomain: thread.teamDomain ?? null, channelId: conversation.channelId, ts: conversation.threadTs });
  let started: SlackConversation | null = null;
  const result = await startServerSession({
    userId: actor.userId,
    projectId: filed.projectId,
    title: filed.title,
    prompt: filed.prompt,
    onCreated: async (workspaceId) => {
      // The session knows its thread: the sidebar's Slack badge, and a link back.
      await createSupabaseAdminClient().from("workspaces").update({ slack_thread_url: threadUrl, slack_sync: true }).eq("id", workspaceId);
      await linkWorkItemToSession(actor, filed.id, { workspaceId, projectId: filed.projectId as string });
      await updateConversation(conversation.id, { state: "started", workspaceId });
      started = { ...conversation, state: "started", workspaceId };
      await reply(
        `Started: <${appUrl(`/workspaces/${workspaceId}`)}|open the session> · <${filed.url}|${filed.key}>. Replies here go to it, and it answers here.`,
      );
    },
  });
  if (result.status === "ready" && started) {
    // Its first turn's reply comes back to the thread like any other.
    await awaitReply(conversation.id);
    await watchForReply(started);
  } else if (result.status !== "ready") {
    if (install) {
      await removeReaction(install.botToken, { channel: conversation.channelId, ts: conversation.threadTs, name: "eyes" }).catch(() => undefined);
    }
    await react("x");
    await reply(`The session for ${filed.key} couldn't start: ${result.errorMessage ?? "unknown error"}. It's still in triage.`);
  }
}

/** Something said in a thread whose session is running: to the session. */
async function toSession(install: SlackInstallation, conversation: SlackConversation, message: AgentMessage) {
  const reply = (text: string) => postMessage(install.botToken, { channel: message.channel, threadTs: conversation.threadTs, text });
  const text = slackToMarkdown(message.text.replace(new RegExp(`<@${install.botUserId}(\\|[^>]*)?>`, "g"), "")).trim();
  if (!text || /^!aside\b/i.test(text) || /^\(aside\)/i.test(text)) return;
  // The session runs as whoever started it, with their access: only someone
  // connected, in the thread's org, who may read its repository, steers it.
  const session = conversation.workspaceId ? await sessionSummary(conversation.workspaceId).catch(() => null) : null;
  const speaker = await actorFor(message.teamId, message.user);
  if (!speaker) {
    await askToConnect(install, { channel: message.channel, user: message.user, threadTs: conversation.threadTs });
    return;
  }
  if (!session || speaker.orgId !== conversation.orgId || !speaker.levels.has(session.projectId)) {
    await postEphemeral(install.botToken, {
      channel: message.channel,
      threadTs: conversation.threadTs,
      user: message.user,
      text: "Only members of this org who can read the session's repository can talk to it.",
    });
    return;
  }
  if (message.mention && /^stop\b/i.test(text)) {
    await reply((await stopSession(conversation)) ? "Stopped the session's turn." : "I couldn't reach the session to stop it.");
    return;
  }
  const names = await userNames(install.botToken, [message.user]);
  const sent = await sendToSession(conversation, fromThread(names.get(message.user) ?? "Someone", text));
  if (sent) {
    await addReaction(install.botToken, { channel: message.channel, ts: message.ts, name: "eyes" }).catch(() => undefined);
    await watchForReply(conversation);
  } else {
    // Sync off, or the session's gone: kept as a note on the item instead.
    await noteOnItem(conversation, message);
  }
}

/** The card's dropdown: the repository it starts in, if the picker may read it. */
async function pickRepo(install: SlackInstallation, conversation: SlackConversation, action: CardAction) {
  if (conversation.state !== "proposed" || !conversation.proposal || !action.selected) return;
  const actor = await actorFor(action.teamId, action.user);
  if (!actor || actor.orgId !== conversation.orgId || !(await resolveProject(actor, action.selected))) {
    await postEphemeral(install.botToken, {
      channel: conversation.channelId,
      threadTs: conversation.threadTs,
      user: action.user,
      text: "You can't start sessions in that repository.",
    });
    return;
  }
  const proposal = { ...conversation.proposal, repo: action.selected };
  await updateConversation(conversation.id, { proposal });
  if (conversation.proposalTs) {
    const repos = (await listOrgProjects(conversation.orgId)).filter((p) => actor.levels.has(p.id)).map((p) => p.fullName);
    await updateMessage(install.botToken, {
      channel: conversation.channelId,
      ts: conversation.proposalTs,
      text: specSummary(proposal),
      blocks: specCard(proposal, conversation.id, repos),
    });
  }
}

/**
 * A pull request opened from the branch of a session that works on an item
 * the agent filed: posted in that item's thread, where the validator's
 * verdict will follow on the PR.
 */
export async function announcePullRequest(pr: {
  repoFullName: string;
  headRef: string;
  number: number;
  url: string;
  title: string;
}): Promise<void> {
  const db = createSupabaseAdminClient();
  const { data: projects, error: projectsError } = await db
    .from("projects")
    .select("id")
    .ilike("full_name", pr.repoFullName.replace(/[\\%_]/g, "\\$&"));
  if (projectsError) throw projectsError;
  if (!projects?.length) return;
  const { data: sessions, error: sessionsError } = await db
    .from("workspaces")
    .select("id")
    .eq("branch", pr.headRef)
    .in(
      "project_id",
      projects.map((p) => p.id),
    );
  if (sessionsError) throw sessionsError;
  if (!sessions?.length) return;
  const { data: items, error: itemsError } = await db
    .from("work_items")
    .select("id, number")
    .in(
      "workspace_id",
      sessions.map((s) => s.id),
    );
  if (itemsError) throw itemsError;
  for (const item of items ?? []) {
    const conversation = await conversationForItem(item.id);
    if (!conversation) continue;
    // Followed from here on: its validator's verdict, and its merge. A new
    // PR on the thread (after one closed unmerged) starts over.
    await updateConversation(conversation.id, {
      pr: { repo: pr.repoFullName, number: pr.number, url: pr.url },
      verdictCommentId: null,
      mergedAnnounced: false,
    });
    const install = await getInstallation(conversation.teamId);
    if (!install) continue;
    await postMessage(install.botToken, {
      channel: conversation.channelId,
      threadTs: conversation.threadTs,
      text: `Pull request for OR-${item.number}: <${pr.url}|#${pr.number} ${pr.title.replace(/[<>|]/g, "")}>. If the repository has the validation automation on, I'll post its verdict here, and when it's merged.`,
    });
  }
}

/**
 * The channel_settings tool: what the agent does in this channel. Changing it
 * needs write on all of the org's projects (an admin, by default): a digest
 * shows what the person who set it may see, to everyone in the channel.
 */
async function changeChannel(asker: TriageActor, message: AgentMessage, args: Record<string, unknown>): Promise<string> {
  if (message.channelType === "im") return JSON.stringify({ error: "Settings are for channels, not DMs." });
  if (asker.orgLevel !== "write") {
    return JSON.stringify({ error: "Changing what I do in a channel needs write on all of the org's workspaces." });
  }
  const tz = typeof args.timezone === "string" && args.timezone.trim() ? args.timezone.trim() : undefined;
  if (tz && !isTimeZone(tz)) return JSON.stringify({ error: `${tz} isn't a time zone I know (use one like Asia/Kolkata).` });
  const hour = typeof args.hour === "number" && Number.isInteger(args.hour) && args.hour >= 0 && args.hour <= 23 ? args.hour : undefined;
  const digest = args.digest === "daily" || args.digest === "weekly" ? args.digest : args.digest === "off" ? null : undefined;
  // The digest shows what whoever set it up may see: that changes only when
  // someone changes the digest, not when they just turn watching on or off.
  const touchesDigest = digest !== undefined || hour !== undefined || tz !== undefined;
  const settings = await setChannelSettings(
    { teamId: message.teamId, channelId: message.channel, orgId: asker.orgId, setBy: touchesDigest ? asker.userId : null },
    {
      ...(typeof args.watch === "boolean" && { watch: args.watch }),
      ...(digest !== undefined && { digest }),
      ...(hour !== undefined && { digestHour: hour }),
      ...(tz !== undefined && { digestTz: tz }),
    },
  );
  return JSON.stringify({
    watch: settings.watch,
    digest: settings.digest ?? "off",
    hour: settings.digestHour,
    timezone: settings.digestTz,
    weeklyOn: settings.digest === "weekly" ? "Mondays" : undefined,
  });
}

/**
 * A new message in a watched channel: if it looks like a bug report or a
 * request, offer (in its thread) to write it up. Nothing is filed until
 * someone says yes.
 */
async function offerIfWork(install: SlackInstallation, message: AgentMessage): Promise<void> {
  if (message.text.trim().length < 15) return;
  const settings = await channelSettings(message.teamId, message.channel);
  if (!settings?.watch) return;
  let key: string;
  try {
    key = await watchModelKey(settings.orgId);
  } catch {
    // A spent allowance included; watchModelKey logs it (a lasting refusal
    // once a minute, a blip each time).
    return;
  }
  let reply: string;
  try {
    reply = await oneShot(key, CLASSIFIER_PROMPT, slackToMarkdown(message.text).slice(0, 4000));
  } catch (error) {
    // Refused since it was kept (spent, or turned off): the next message asks
    // afresh, and is refused before calling.
    forgetWatchModelKey(settings.orgId);
    throw error;
  }
  const classification = parseClassification(reply);
  if (classification.kind === "none") return;
  await postMessage(install.botToken, {
    channel: message.channel,
    threadTs: message.ts,
    text: `This looks like ${classification.kind === "bug" ? "a bug report" : "a request"}: ${classification.summary}`,
    blocks: watchOffer(classification, `${message.channel}|${message.ts}`),
  });
}

/** A click on a button the agent posted on its own. */
export type ProactiveAction = {
  actionId: string;
  value: string;
  teamId: string;
  user: string;
  userName?: string | null;
  channel?: string | null;
  messageTs?: string | null;
  messageBlocks?: Record<string, unknown>[] | null;
};

export async function handleProactiveAction(action: ProactiveAction): Promise<void> {
  const install = await getInstallation(action.teamId);
  if (!install) return;
  try {
    if (action.actionId === PROACTIVE_ACTIONS.watchFile || action.actionId === PROACTIVE_ACTIONS.watchDismiss) {
      const [channel, ts] = action.value.split("|");
      if (!channel || !ts) return;
      const takeDown = () =>
        action.messageTs ? deleteMessage(install.botToken, { channel, ts: action.messageTs }).catch(() => undefined) : undefined;
      if (action.actionId === PROACTIVE_ACTIONS.watchDismiss) {
        await takeDown();
        return;
      }
      // The offer stays for everyone until someone who can file says yes.
      const actor = await actorFor(action.teamId, action.user);
      if (!actor) {
        await askToConnect(install, { channel, user: action.user, threadTs: ts });
        return;
      }
      await takeDown();
      const conversation =
        (await getConversation(action.teamId, channel, ts)) ??
        (await openConversation({ teamId: action.teamId, channelId: channel, threadTs: ts, orgId: actor.orgId, startedBy: actor.userId }));
      await runTurn(install, conversation, { teamId: action.teamId, channel, user: action.user, text: "", ts, threadTs: ts, mention: true });
      return;
    }

    if (action.actionId !== PROACTIVE_ACTIONS.sendBack && action.actionId !== PROACTIVE_ACTIONS.leave) return;
    const conversation = await getConversationById(action.value);
    if (!conversation || conversation.teamId !== action.teamId) return;
    const where = { channel: conversation.channelId, threadTs: conversation.threadTs };
    const tellClicker = (text: string) => postEphemeral(install.botToken, { ...where, user: action.user, text });
    const by = action.userName ? `@${action.userName}` : `<@${action.user}>`;
    // The verdict stays; its buttons go.
    const settle = async (note: string) => {
      if (!action.messageTs || !action.messageBlocks) return;
      await updateMessage(install.botToken, {
        channel: conversation.channelId,
        ts: action.messageTs,
        text: note,
        blocks: [...action.messageBlocks.filter((b) => b.type !== "actions"), { type: "context", elements: [{ type: "mrkdwn", text: note }] }],
      }).catch(() => undefined);
    };
    if (action.actionId === PROACTIVE_ACTIONS.leave) {
      await settle(`Left as it is by ${by}.`);
      return;
    }

    const actor = await actorFor(action.teamId, action.user);
    if (!actor || actor.orgId !== conversation.orgId) {
      await askToConnect(install, { ...where, user: action.user });
      return;
    }
    const item = conversation.itemId ? await getWorkItem(actor, conversation.itemId) : null;
    const session = await threadSession(conversation);
    if (!item || !session || !conversation.pr || !conversation.verdictCommentId) {
      await tellClicker("There's no session or verdict to send back here.");
      return;
    }
    // The session's owner, or someone who may triage the item.
    if (actor.userId !== session.ownerId && !canTriage(actor, item)) {
      await tellClicker("Sending work back needs write on its workspace, or to be the one whose session it is.");
      return;
    }
    const token = await repoToken(conversation.orgId, conversation.pr.repo);
    const comment = token
      ? await githubGet<{ body?: string }>(token, `/repos/${conversation.pr.repo}/issues/comments/${conversation.verdictCommentId}`)
      : null;
    if (!comment?.body) {
      await tellClicker("I couldn't read the validator's comment on GitHub.");
      return;
    }
    const key = itemKey(item);
    await settle(`Sent back to the session by ${by}.`);
    const sent = await wakeAndSend(session.ownerId, session.id, sendBackPrompt(key, comment.body), "slack").catch(() => false);
    await postMessage(install.botToken, {
      ...where,
      text: sent
        ? `Sent ${key} back to its session with the validator's findings. The validator checks again when the pull request updates.`
        : `I couldn't reach ${key}'s session (it may have been archived). Start a new one from the item.`,
    });
  } catch (error) {
    console.error("Slack agent: the action failed", error);
  }
}
