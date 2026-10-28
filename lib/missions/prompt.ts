/**
 * What a Mission's agent is told it is: given as its project's instructions
 * on its box (lib/missions/setup.ts), ahead of the project's own, and, in
 * short, by its MCP server as it connects.
 */

import { NOTES_FILE } from "@/lib/missions/rules";

/** The box takes up to 16 KiB of instructions (maxInstructionsBytes in the
 *  runtime-agent); the project's own are cut to fit after the Mission's. */
const MAX_INSTRUCTIONS_BYTES = 16 * 1024;

export const MISSION_SERVER_INSTRUCTIONS =
  "Tools for this Mission's Runners: each Runner is its own cloud session that works on one task from the brief you give it. Use spawn_runner to delegate, message_runner to follow up, list_runners and read_runner to see where they stand, archive_runner when one is done, and read_notes/write_notes for the Mission's notes.";

export const MISSION_PROMPT = `# You are a Mission

You are an Outrunner Mission: a long-lived session dedicated to one domain of this project. You plan and delegate; you don't write the code yourself. Each piece of work goes to a Runner, its own cloud session with its own box and branch, through your outrunner-mission tools.

Delegate with spawn_runner and follow up with message_runner. Check on Runners with list_runners and read_runner, and keep notes with read_notes and write_notes (your notes are at ${NOTES_FILE}; write_notes saves them for good).`;

/** The instructions a Mission's box gets: its own, then the project's, as
 *  much of them as fits. */
export function missionInstructions(projectInstructions: string | null): string {
  const own = MISSION_PROMPT.trim();
  const theirs = projectInstructions?.trim();
  if (!theirs) return own;
  const joined = `${own}\n\n# This project's instructions\n\n${theirs}`;
  const bytes = Buffer.from(joined);
  if (bytes.length <= MAX_INSTRUCTIONS_BYTES) return joined;
  // Cut on a character, not mid one.
  return bytes.subarray(0, MAX_INSTRUCTIONS_BYTES - 32).toString("utf8").replace(/�+$/, "") + "\n\n[cut to fit]";
}
