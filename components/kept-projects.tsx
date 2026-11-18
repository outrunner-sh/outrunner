"use client";

import { useEffect } from "react";

import { useAppData, useViewerScope } from "@/components/app-data";
import { ProjectsIndex } from "@/components/projects-index";
import { RouteLoading } from "@/components/route-states";
import { keptPage } from "@/lib/client/kept-page";
import type { Project } from "@/lib/runtime/types";

/** Whether the user may sync repositories here, as the server last said: the
 *  one thing on Projects the sidebar's data doesn't carry. */
const KEPT_CAN_SYNC = keptPage<boolean>("projects-can-sync", 1, (value): value is boolean => typeof value === "boolean");

/** The server's answer: shown, and what it said of syncing kept for
 *  `scope` (null with no org, when nothing is kept). */
export function ServedProjects({ projects, canSync, scope }: { projects: Project[]; canSync: boolean; scope: string | null }) {
  useEffect(() => {
    if (scope) KEPT_CAN_SYNC.remember(canSync, scope);
  }, [canSync, scope]);
  return <ProjectsIndex projects={projects} canSync={canSync} />;
}

/**
 * While the server reads the org's projects: the same list from the sidebar's
 * data, which the layout read already (or kept, components/app-frame.tsx), so
 * Projects paints at once rather than holding the page it was opened from.
 */
export function KeptProjects() {
  const data = useAppData();
  const canSync = KEPT_CAN_SYNC.useKept(useViewerScope());
  return data ? <ProjectsIndex projects={data.projects} canSync={canSync ?? false} /> : <RouteLoading label="Loading environments" />;
}
