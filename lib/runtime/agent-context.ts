/**
 * What every session on a box reads before its first turn, besides its
 * orientation: the learnings its user and org keep (lib/learnings). Sent to
 * the box as one piece of Markdown (POST /agent-context), which the agent
 * puts in a block of its own in Claude's ~/.claude/CLAUDE.md and Codex's
 * ~/.codex/AGENTS.md, between markers, leaving whatever the user keeps
 * there as it was (runtime-agent/internal/workspace/agentcontext.go).
 *
 * Pure, for the setup and the tests.
 */

import type { Learning } from "@/lib/learnings/rules";

/** The most the block may hold: the box refuses more. Past it, the newest
 *  learnings are left out, said. */
export const MAX_AGENT_CONTEXT_CHARS = 48 * 1024;

export type AgentContextInput = {
  /** The org the session is in, by name; null for a person's own org. */
  orgName: string | null;
  learnings: { org: Learning[]; personal: Learning[] };
};

function section(heading: string, intro: string, learnings: Learning[]): string {
  const items = learnings.map((l) => `### ${l.title}\n\n${l.body}`);
  return [`## ${heading}`, intro, ...items].join("\n\n");
}

/** The block's Markdown; empty when there's nothing to load, and the box
 *  then removes any block an earlier session left. */
export function renderAgentContext({ orgName, learnings }: AgentContextInput): string {
  const sections: string[] = [];
  if (learnings.org.length > 0) {
    sections.push(section(orgName ? `${orgName}'s learnings` : "Your org's learnings", "Kept by the org's admins for every session.", learnings.org));
  }
  if (learnings.personal.length > 0) {
    sections.push(section("The user's learnings", "Kept by the user for every session of theirs.", learnings.personal));
  }
  if (sections.length === 0) return "";
  const head =
    "# Outrunner learnings\n\n" +
    "Standing instructions, kept in Outrunner (Settings → Learnings) and loaded into every session. " +
    "Follow them; where one conflicts with what the user asks in this session, the user's message wins.";
  let text = [head, ...sections].join("\n\n");
  if (text.length > MAX_AGENT_CONTEXT_CHARS) {
    const note = "\n\n(Some learnings were left out: there are more than a session can load.)";
    text = text.slice(0, MAX_AGENT_CONTEXT_CHARS - note.length).replace(/\n[^\n]*$/, "") + note;
  }
  return text;
}
