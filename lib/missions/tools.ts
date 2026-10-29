/**
 * The Runner's tools for its Ships (docs/missions.md), as plain functions:
 * the Runner's MCP endpoint (app/api/missions/mcp) serves them, and the
 * org-wide MCP server can register the same ones later. Each is called for
 * one Runner (`scope`, from its token), and reaches only that Runner's
 * Ships: a Ship of another Runner, or any other session, reads as no Ship at
 * all, so a token can't even learn that one exists.
 *
 * What touches the world comes in as `deps` (lib/missions/tools.deps.ts), so
 * the scoping and the refusals here test without a database or a box.
 */

import type { RunnerPullRequest } from "@/lib/missions/pulls";
import {
  boolArg,
  isLiveRunner,
  MAX_RUNNERS,
  NOTES_FILE,
  NOTES_MAX_CHARS,
  runnerPlacesLeft,
  runnerState,
  textArg,
} from "@/lib/missions/rules";
import type { Workspace } from "@/lib/runtime/types";

/** The Runner a call is for: the one its token names. */
export type MissionScope = { missionId: string };

/** What spawn_runner asks for when starting a Ship. */
export type RunnerStart = {
  /** Its brief, as the Runner wrote it: kept, and its name's source. */
  brief: string;
  /** Plan first: its first message asks for a plan before any change. */
  planMode: boolean;
  name: string | undefined;
  model: string | undefined;
  agent: string | undefined;
  effort: string | undefined;
};

export type MissionToolDeps = {
  /** Why the Runner's owner may no longer use its tools (they lost read on
   *  its project, or left its org), or null when they may. Asked on every call. */
  access(mission: Workspace): Promise<string | null>;
  /** Why a Ship can't be started from the Runner's project now (gone,
   *  archived, no repositories), or null when one can. */
  environmentReady(mission: Workspace): Promise<string | null>;
  /** Any session by id, whoever's. */
  session(id: string): Promise<Workspace | null>;
  runners(missionId: string): Promise<Workspace[]>;
  working(session: Workspace): Promise<boolean>;
  /** Its latest reply: read from its box, else the last one recorded. */
  latestResponse(session: Workspace): Promise<string | null>;
  pullRequests(runner: Workspace): Promise<RunnerPullRequest[]>;
  startRunner(mission: Workspace, start: RunnerStart): Promise<{ runnerId: string } | { error: string }>;
  /** Send as the owner, waking or restoring it first; false when it can't be. */
  send(runner: Workspace, content: string): Promise<boolean>;
  queue(missionId: string, runnerId: string, content: string): Promise<void>;
  queued(runnerIds: string[]): Promise<Map<string, number>>;
  archive(runner: Workspace): Promise<boolean>;
  readNotes(missionId: string): Promise<{ body: string; updatedAt: string | null }>;
  writeNotes(missionId: string, body: string): Promise<void>;
};

export type ToolResult = { text: string; isError?: boolean };

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const RUNNER_ID = { type: "string", description: "The Ship's id, as spawn_runner or list_runners gave it." };

export const MISSION_TOOLS: ToolDefinition[] = [
  {
    name: "spawn_runner",
    description:
      `Start a Ship: a new cloud session delegated by this Runner, in its project, with its own box and branch, to work on one task. It sees only the brief you write, so make it self-contained: the goal, the context it needs, what done looks like (usually a pull request). Runs on this Runner's model unless model, agent or effort says otherwise. At most ${MAX_RUNNERS} Ships that aren't archived.`,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The Ship's brief: everything it knows about the task." },
        name: { type: "string", description: "A short name for the Ship, shown under the Runner in the sidebar." },
        model: { type: "string", description: "A model id to run it on instead of this Runner's." },
        agent: { type: "string", enum: ["claude", "codex"], description: "The coding agent to run." },
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "Thinking effort." },
        plan_mode: { type: "boolean", description: "Have it reply with a plan first and change nothing until told to go ahead." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "message_runner",
    description:
      "Send a Ship a follow-up. A working Ship is steered mid-turn unless queue is set, in which case the message waits for its turn to end. An idle Ship starts a new turn; an asleep or archived one is woken or restored first.",
    inputSchema: {
      type: "object",
      properties: {
        runner_id: RUNNER_ID,
        message: { type: "string", description: "What to tell it." },
        queue: { type: "boolean", description: "Hold it until the Ship's current turn ends, rather than steering." },
      },
      required: ["runner_id", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "list_runners",
    description:
      "List this Runner's Ships: each one's state (setting_up, working, idle, asleep, archived, failed), its pull requests with their CI checks and mergeability, and messages queued for it.",
    inputSchema: {
      type: "object",
      properties: { include_archived: { type: "boolean", description: "Include archived Ships too." } },
      additionalProperties: false,
    },
  },
  {
    name: "read_runner",
    description: "Read one Ship: its settings, its pull requests and their status, and its latest response.",
    inputSchema: { type: "object", properties: { runner_id: RUNNER_ID }, required: ["runner_id"], additionalProperties: false },
  },
  {
    name: "archive_runner",
    description:
      "Archive a finished Ship, freeing its place and its box. Refuses one that is working or has an open pull request unless force is set; a Ship whose pull requests are all merged or closed is archived on its own, so this is rarely needed. Don't force it to free a box: its pull request still needs it for fixes. Messaging it later restores it.",
    inputSchema: {
      type: "object",
      properties: {
        runner_id: RUNNER_ID,
        force: { type: "boolean", description: "Archive it even so: only when its work is abandoned, or the user asked." },
      },
      required: ["runner_id"],
      additionalProperties: false,
    },
  },
  {
    name: "read_notes",
    description: `Read this Runner's notes. They are also on your box at ${NOTES_FILE}, as they were when it started.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "write_notes",
    description: `Replace this Runner's notes with content (Markdown, up to ${NOTES_MAX_CHARS} characters). Saved notes outlive this box; edits to ${NOTES_FILE} alone don't.`,
    inputSchema: {
      type: "object",
      properties: { content: { type: "string", description: "The whole of the notes." } },
      required: ["content"],
      additionalProperties: false,
    },
  },
];

const NO_SUCH_RUNNER: ToolResult = { text: "This Runner has no Ship with that id. list_runners shows its Ships.", isError: true };

function refuse(text: string): ToolResult {
  return { text, isError: true };
}

function json(value: unknown): ToolResult {
  return { text: JSON.stringify(value, null, 2) };
}

/** The Runner the scope names, if it is one still. */
async function missionOf(scope: MissionScope, deps: MissionToolDeps): Promise<Workspace | null> {
  const mission = await deps.session(scope.missionId);
  if (!mission || mission.kind !== "mission" || mission.status === "destroyed" || mission.status === "destroying") return null;
  return mission;
}

/** One of the Runner's own Ships, or null for any other id. */
export async function ownRunner(mission: Workspace, runnerId: unknown, deps: MissionToolDeps): Promise<Workspace | null> {
  if (typeof runnerId !== "string" || !runnerId) return null;
  const runner = await deps.session(runnerId);
  if (!runner || runner.parentMissionId !== mission.id || runner.ownerId !== mission.ownerId) return null;
  if (runner.status === "destroyed" || runner.status === "destroying") return null;
  return runner;
}

function pullView(pr: RunnerPullRequest) {
  return {
    repo: pr.repo,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: pr.status?.state ?? "unknown",
    draft: pr.status?.draft ?? null,
    checks: pr.status?.checks ?? null,
    mergeable: pr.status?.mergeableState ?? null,
    summary: pr.verdict?.label ?? "GitHub couldn't be asked",
  };
}

async function runnerView(runner: Workspace, deps: MissionToolDeps, queued: number) {
  const [working, pulls] = await Promise.all([
    deps.working(runner).catch(() => false),
    isLiveRunner(runner) ? deps.pullRequests(runner).catch(() => []) : Promise.resolve([]),
  ]);
  return {
    id: runner.id,
    name: runner.title ?? runner.branch,
    state: runnerState(runner.status, working),
    branch: runner.branch,
    agent: runner.agent,
    model: runner.model ? { id: runner.model.model.id, provider: runner.model.model.provider, effort: runner.model.effort } : null,
    pull_requests: pulls.map(pullView),
    queued_messages: queued,
    ...(runner.status === "failed" && runner.errorMessage && { error: runner.errorMessage }),
  };
}

/** Run one tool for the Runner the scope names. */
export async function callMissionTool(
  scope: MissionScope,
  name: string,
  args: Record<string, unknown>,
  deps: MissionToolDeps,
): Promise<ToolResult> {
  const mission = await missionOf(scope, deps);
  if (!mission) return refuse("This Runner is gone, so its tools no longer work.");
  // Rechecked each call: access taken away since the box started counts now.
  const denied = await deps.access(mission);
  if (denied) return refuse(denied);
  switch (name) {
    case "spawn_runner":
      return spawnRunner(mission, args, deps);
    case "message_runner":
      return messageRunner(mission, args, deps);
    case "list_runners":
      return listRunners(mission, args, deps);
    case "read_runner":
      return readRunner(mission, args, deps);
    case "archive_runner":
      return archiveRunner(mission, args, deps);
    case "read_notes": {
      const notes = await deps.readNotes(mission.id);
      return { text: notes.body || "(No notes yet.)" };
    }
    case "write_notes": {
      const content = typeof args.content === "string" ? args.content : null;
      if (content === null) return refuse("content is required: the whole of the notes.");
      if (content.length > NOTES_MAX_CHARS) return refuse(`Notes are capped at ${NOTES_MAX_CHARS} characters; these are ${content.length}.`);
      await deps.writeNotes(mission.id, content);
      return { text: "Notes saved." };
    }
    default:
      return refuse(`No tool is called ${name}.`);
  }
}

async function spawnRunner(mission: Workspace, args: Record<string, unknown>, deps: MissionToolDeps): Promise<ToolResult> {
  const prompt = textArg(args, "prompt");
  if (!prompt) return refuse("prompt is required: the Ship's brief.");
  const notReady = await deps.environmentReady(mission);
  if (notReady) return refuse(`The Ship didn't start: ${notReady}`);
  const places = runnerPlacesLeft(await deps.runners(mission.id));
  if (places === 0) {
    return refuse(`This Runner already has ${MAX_RUNNERS} Ships that aren't archived. Archive a finished one (archive_runner) first.`);
  }
  const started = await deps.startRunner(mission, {
    brief: prompt,
    planMode: boolArg(args, "plan_mode"),
    name: textArg(args, "name")?.slice(0, 120),
    model: textArg(args, "model"),
    agent: textArg(args, "agent"),
    effort: textArg(args, "effort"),
  });
  if ("error" in started) return refuse(`The Ship didn't start: ${started.error}`);
  return json({
    runner_id: started.runnerId,
    note: "It's setting up its box and starts on the brief once ready. You hear when its turn ends; there is no need to poll.",
  });
}

async function messageRunner(mission: Workspace, args: Record<string, unknown>, deps: MissionToolDeps): Promise<ToolResult> {
  const runner = await ownRunner(mission, args.runner_id, deps);
  if (!runner) return NO_SUCH_RUNNER;
  const message = textArg(args, "message");
  if (!message) return refuse("message is required.");
  if (runner.status === "failed") return refuse("That Ship failed to start, so it can't take messages. Spawn another.");
  if (runner.status === "creating" || runner.status === "provisioning") {
    await deps.queue(mission.id, runner.id, message);
    return { text: "The Ship is still setting up: your message waits, and goes once its first turn ends." };
  }
  const working = await deps.working(runner).catch(() => false);
  if (working && boolArg(args, "queue")) {
    await deps.queue(mission.id, runner.id, message);
    return { text: "Queued: it goes when the Ship's current turn ends." };
  }
  if (!(await deps.send(runner, message))) {
    return refuse(
      runner.status === "archived" && runnerPlacesLeft(await deps.runners(mission.id)) === 0
        ? `That Ship is archived, and restoring it would put this Runner over ${MAX_RUNNERS} Ships. Archive another first.`
        : "The Ship couldn't take the message (its box didn't answer). Try again shortly.",
    );
  }
  return {
    text: working
      ? "Sent: it steers the Ship's current turn."
      : runner.status === "archived"
        ? "Sent: the Ship is being restored, and starts a new turn on it."
        : "Sent: the Ship starts a new turn on it.",
  };
}

async function listRunners(mission: Workspace, args: Record<string, unknown>, deps: MissionToolDeps): Promise<ToolResult> {
  const all = await deps.runners(mission.id);
  const shown = boolArg(args, "include_archived") ? all : all.filter(isLiveRunner);
  const queued = await deps.queued(shown.map((r) => r.id)).catch(() => new Map<string, number>());
  const runners = await Promise.all(shown.map((r) => runnerView(r, deps, queued.get(r.id) ?? 0)));
  return json({ runners, places_left: runnerPlacesLeft(all) });
}

async function readRunner(mission: Workspace, args: Record<string, unknown>, deps: MissionToolDeps): Promise<ToolResult> {
  const runner = await ownRunner(mission, args.runner_id, deps);
  if (!runner) return NO_SUCH_RUNNER;
  const queued = await deps.queued([runner.id]).catch(() => new Map<string, number>());
  const [view, latest] = await Promise.all([
    runnerView(runner, deps, queued.get(runner.id) ?? 0),
    deps.latestResponse(runner).catch(() => null),
  ]);
  return json({ ...view, latest_response: latest });
}

async function archiveRunner(mission: Workspace, args: Record<string, unknown>, deps: MissionToolDeps): Promise<ToolResult> {
  const runner = await ownRunner(mission, args.runner_id, deps);
  if (!runner) return NO_SUCH_RUNNER;
  if (runner.status === "archived" || runner.status === "archiving") return { text: "That Ship is archived already." };
  const force = boolArg(args, "force");
  if (!force) {
    if (await deps.working(runner).catch(() => false)) {
      return refuse("That Ship is working. Wait for its turn to end, or set force to archive it anyway.");
    }
    const open = (await deps.pullRequests(runner).catch(() => [])).filter((p) => p.status === null || p.status.state === "open");
    if (open.length > 0) {
      return refuse(
        `That Ship has an open pull request (${open.map((p) => p.url).join(", ")}). It's archived on its own once they're merged or closed; set force to archive it now.`,
      );
    }
  }
  if (!(await deps.archive(runner))) return refuse("The Ship couldn't be archived just now. Try again shortly.");
  return { text: "Archived. Messaging it restores it." };
}
