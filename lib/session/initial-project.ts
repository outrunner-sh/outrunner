/**
 * Which repository the new-session form starts on. With none requested, the
 * first listed. With one requested, that one if it is listed, and otherwise
 * none ("") so the user has to pick: a session must never be created in a
 * repository nobody chose (a deleted one, or one the list leaves out).
 */
export function initialProjectId(projects: { id: string }[], requested?: string): string {
  if (requested === undefined) return projects[0]?.id ?? "";
  return projects.some((p) => p.id === requested) ? requested : "";
}
