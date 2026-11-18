"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect } from "react";

import { useAppData, useViewerScope } from "@/components/app-data";
import { type EnvironmentsAccess, ProjectsIndex } from "@/components/projects-index";
import { RouteLoading } from "@/components/route-states";
import { keptPage } from "@/lib/client/kept-page";
import type { ListedEnvironment } from "@/lib/environments/listed";
import type { Project } from "@/lib/runtime/types";

/** What the user may do here, as the server last said: the one thing on
 *  Environments the sidebar's data doesn't carry. */
const KEPT_ACCESS = keptPage<EnvironmentsAccess>(
  "environments-access",
  2,
  (value): value is EnvironmentsAccess =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as EnvironmentsAccess).canConnect === "boolean" &&
    typeof (value as EnvironmentsAccess).admin === "boolean" &&
    typeof (value as EnvironmentsAccess).orgName === "string",
);

/** Nothing kept yet: nothing offered to change until the server says. */
const NO_ACCESS: EnvironmentsAccess = { canConnect: false, admin: false, orgName: "" };

/** `?pick=1` (Settings → Org → GitHub's "Pick repositories"): the picker
 *  opens, and the URL forgets it once it has, so back or a reload doesn't
 *  open it again. */
function usePickAsked(): { pick: boolean; forget: () => void } {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const pick = search.get("pick") === "1";
  const forget = useCallback(() => {
    if (pick) router.replace(pathname, { scroll: false });
  }, [pick, pathname, router]);
  return { pick, forget };
}

/** The server's answer: shown, and what it said of access kept for `scope`
 *  (null with no org, when nothing is kept). */
export function ServedProjects({
  projects,
  environments,
  access,
  scope,
}: {
  projects: Project[];
  environments: ListedEnvironment[];
  access: EnvironmentsAccess;
  scope: string | null;
}) {
  const { pick, forget } = usePickAsked();
  useEffect(() => {
    if (scope) KEPT_ACCESS.remember(access, scope);
  }, [access, scope]);
  return <ProjectsIndex projects={projects} environments={environments} access={access} pick={pick} onPicked={forget} />;
}

/**
 * While the server reads the org's environments: the same lists from the
 * sidebar's data, which the layout read already (or kept,
 * components/app-frame.tsx), so Environments paints at once rather than
 * holding the page it was opened from.
 */
export function KeptProjects() {
  const data = useAppData();
  const access = KEPT_ACCESS.useKept(useViewerScope());
  const { pick, forget } = usePickAsked();
  return data ? (
    <ProjectsIndex projects={data.projects} environments={data.environments ?? []} access={access ?? NO_ACCESS} pick={pick} onPicked={forget} />
  ) : (
    <RouteLoading label="Loading environments" />
  );
}
