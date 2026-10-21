/**
 * What onboarding offers to bring over from this Mac: the sessions the
 * desktop app's scan found (Conductor, Claude Code, Codex) that can move to
 * the cloud. Offered only when there are some, as Claude is only when it's
 * found (claude-choice.ts). Imports no React, so the tests use it as is.
 */

import { IMPORT_SOURCE_LABELS, type ImportScan, type ImportSource } from "@/lib/runtime/import-scan";

/** How many sessions can be imported, and from where, in the scan's order. */
export type ImportFound = { sessions: number; sources: ImportSource[] };

/** Null with nothing to import: no scan (outside the Mac app), or only
 *  sessions the scan says can't move. */
export function importFound(scan: ImportScan | null): ImportFound | null {
  const importable = (scan?.sessions ?? []).filter((s) => !s.skip);
  if (importable.length === 0) return null;
  const sources = [...new Set(importable.map((s) => s.source))];
  return { sessions: importable.length, sources };
}

/** "Found 14 sessions in Conductor and Claude Code." */
export function importFoundText({ sessions, sources }: ImportFound): string {
  const names = sources.map((s) => IMPORT_SOURCE_LABELS[s]);
  const where = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return `Found ${sessions} ${sessions === 1 ? "session" : "sessions"} in ${where}.`;
}
