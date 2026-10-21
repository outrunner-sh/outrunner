/**
 * What onboarding offers to bring over from this Mac: the scan's sessions
 * (Conductor, Claude Code, Codex) grouped by the GitHub repository they work
 * in, each one a project. A session is active when it was worked in within
 * the last 30 days; older ones are offered only on request. Imports no React,
 * so the tests use it as is.
 */

import { offeredSessions } from "@/lib/imports/client";
import { IMPORT_SOURCES, type ImportScan, type ImportSource, type ScannedSession } from "@/lib/runtime/import-scan";

/** How recently a session was worked in to count as active. */
export const ACTIVE_FOR_MS = 30 * 24 * 60 * 60 * 1000;

export type ImportProject = {
  /** "owner/name", as its most recent session has it. */
  repo: string;
  /** Worked in within ACTIVE_FOR_MS, newest first. */
  active: ScannedSession[];
  /** The rest, newest first: those with no time at all last. */
  older: ScannedSession[];
};

/** When a session was last worked in, as ms; null when the scan can't say. */
function lastWorked(s: ScannedSession): number | null {
  const at = Date.parse(s.updatedAt ?? s.startedAt ?? "");
  return Number.isNaN(at) ? null : at;
}

const newestFirst = (a: ScannedSession, b: ScannedSession) => (lastWorked(b) ?? -Infinity) - (lastWorked(a) ?? -Infinity);

/**
 * The projects a scan offers, the most recently worked in first. Only what
 * can be imported counts: no skip, a repository and a branch, and not
 * archived in Conductor. Repositories are matched in any case, as GitHub
 * does. Empty with no scan.
 */
export function importProjects(scan: ImportScan | null, now: number): ImportProject[] {
  const sessions = offeredSessions(scan?.sessions ?? []).importable.filter((s) => s.repo && s.branch);
  const byRepo = new Map<string, ScannedSession[]>();
  for (const s of [...sessions].sort(newestFirst)) {
    const key = s.repo!.toLowerCase();
    byRepo.set(key, [...(byRepo.get(key) ?? []), s]);
  }
  return [...byRepo.values()].map((list) => {
    const isActive = (s: ScannedSession) => {
      const at = lastWorked(s);
      return at !== null && now - at <= ACTIVE_FOR_MS;
    };
    return { repo: list[0].repo!, active: list.filter(isActive), older: list.filter((s) => !isActive(s)) };
  });
}

/** A project's sessions on screen: its active ones, and the older ones when asked for. */
export function shownSessions(project: ImportProject, withOlder: boolean): ScannedSession[] {
  return withOlder ? [...project.active, ...project.older] : project.active;
}

/** Where a project's sessions come from, in the order IMPORT_SOURCES lists them. */
export function projectSources(sessions: ScannedSession[]): ImportSource[] {
  const found = new Set(sessions.map((s) => s.source));
  return IMPORT_SOURCES.filter((source) => found.has(source));
}
