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

/** The most the block may hold, in UTF-8 bytes as the box counts them (it
 *  refuses more than 64 KB). Past it, whole learnings are left out, said. */
export const MAX_AGENT_CONTEXT_BYTES = 48 * 1024;

export type AgentContextInput = {
  /** The org the session is in, by name; null for a person's own org. */
  orgName: string | null;
  learnings: { org: Learning[]; personal: Learning[] };
};

const encoder = new TextEncoder();

/** Text's size as the box measures it. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

const HEAD =
  "# Outrunner learnings\n\n" +
  "Standing instructions, kept in Outrunner (Settings → Learnings) and loaded into every session. " +
  "Follow them; where one conflicts with what the user asks in this session, the user's message wins.";

function item(learning: Learning): string {
  return `### ${learning.title}\n\n${learning.body}`;
}

/** The first learnings whose items fit in `budget` bytes, whole. */
function fitting(learnings: Learning[], budget: number): { items: string[]; used: number } {
  const items: string[] = [];
  let used = 0;
  for (const learning of learnings) {
    const text = item(learning);
    const size = utf8Bytes(text) + 2;
    if (used + size > budget) break;
    items.push(text);
    used += size;
  }
  return { items, used };
}

/**
 * The block's Markdown; empty when there's nothing to load, and the box then
 * removes any block an earlier session left. Learnings go in whole or not at
 * all, never cut partway through an instruction. When they don't all fit, the
 * user's own get half the room first, so a long org list can't push them all
 * out, then the org's take what's left, and the user's the rest.
 */
export function renderAgentContext({ orgName, learnings }: AgentContextInput): string {
  if (learnings.org.length === 0 && learnings.personal.length === 0) return "";
  const orgHeading = `## ${orgName ? `${orgName}'s learnings` : "Your org's learnings"}\n\nKept by the org's admins for every session.`;
  const personalHeading = "## The user's learnings\n\nKept by the user for every session of theirs.";
  const note = "(Some learnings were left out: there are more than a session can load.)";
  const budget = MAX_AGENT_CONTEXT_BYTES - utf8Bytes(HEAD) - utf8Bytes(orgHeading) - utf8Bytes(personalHeading) - utf8Bytes(note) - 16;

  const personalFirst = fitting(learnings.personal, Math.floor(budget / 2));
  const org = fitting(learnings.org, budget - personalFirst.used);
  const personal = fitting(learnings.personal, budget - org.used);

  const sections: string[] = [HEAD];
  if (org.items.length > 0) sections.push([orgHeading, ...org.items].join("\n\n"));
  if (personal.items.length > 0) sections.push([personalHeading, ...personal.items].join("\n\n"));
  if (org.items.length < learnings.org.length || personal.items.length < learnings.personal.length) sections.push(note);
  return sections.join("\n\n");
}
