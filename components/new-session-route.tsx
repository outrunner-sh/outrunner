"use client";

import { useSearchParams } from "next/navigation";

import { useAppData } from "@/components/app-data";
import { NewSessionCreator } from "@/components/new-session-creator";
import { useServerAnswer } from "@/components/server-answer";
import type { Project } from "@/lib/runtime/types";
import { lastSessionProjectId } from "@/lib/session/initial-project";
import { useNewSessionCount } from "@/lib/session/new-session-reset";

/**
 * Home: the new-session form, on the repository of the most recent session,
 * from what the sidebar holds. A fresh form on each "New Session".
 */
export function HomeSessionRoute() {
  const data = useAppData();
  const projects = data?.projects ?? [];
  const asked = useNewSessionCount();
  return (
    <NewSessionCreator
      key={asked}
      projects={projects}
      projectsKnown={data !== null}
      initialProjectId={lastSessionProjectId(projects, data?.workspaces ?? [])}
    />
  );
}

/**
 * /new: the form a sidebar "+" opens, on the repository (`?project=`) or Mac
 * folder (`?folder=`) it names, from what the sidebar holds. A repository the
 * list hides is still a valid place to start: the sidebar has it when a
 * session is in it, and otherwise the server's answer (`server`, a Project)
 * adds it, rather than the form falling back to some other repository.
 */
export function NewSessionRoute({ server }: { server: React.ReactNode }) {
  const data = useAppData();
  const search = useSearchParams();
  const project = search.get("project") ?? undefined;
  const folder = search.get("folder") ?? "";
  const asked = useNewSessionCount();
  const [answered, slot] = useServerAnswer<Project>(server);

  const listed = data?.projects ?? [];
  const requested = [...(data?.hiddenProjects ?? []), ...(answered ? [answered] : [])].find((p) => p.id === project);
  const projects = requested && !listed.some((p) => p.id === requested.id) ? [requested, ...listed] : listed;

  return (
    <>
      <NewSessionCreator
        // A new form per "New Session" and per target: arriving while already
        // on /new must not keep the repository, folder or cloud/Mac choice the
        // open form was switched to.
        key={`${project ?? ""}\n${folder}\n${asked}`}
        projects={projects}
        // A hidden repository asked for may still be on its way from the
        // server: the form picks it up as it lands, until one is picked.
        projectsKnown={data !== null}
        initialProjectId={project}
        showBack
      />
      {slot}
    </>
  );
}
