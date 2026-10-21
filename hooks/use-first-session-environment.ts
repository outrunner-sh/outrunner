"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { useSharedResource } from "@/hooks/use-shared-resource";
import { postJson } from "@/lib/client/post-json";
import { sharedResource, type SharedResource } from "@/lib/client/shared-resource";
import { importEnvironment, importScan } from "@/lib/desktop/local-runtime";
import {
  emptyEnvPick,
  type EnvironmentPick,
  environmentFor,
  environmentPickSecrets,
  hasEnvironmentPick,
  importEnvironments,
} from "@/lib/imports/client";
import type { ImportEnvCapture, ImportScan, ScannedProjectEnv } from "@/lib/runtime/import-scan";
import { isDesktopApp } from "@/lib/is-desktop";
import type { Project } from "@/lib/runtime/types";

/** What this Mac has, read once a page: it reads every session, so it isn't
 *  quick, and a project's environment rarely changes while the app is open. */
const macScan = sharedResource<ImportScan | null>(() => importScan(), null);

/** Whether each project has an environment kept for its cloud sessions. */
const keptResources = new Map<string, SharedResource<boolean | null>>();

function keptResource(projectId: string): SharedResource<boolean | null> {
  let resource = keptResources.get(projectId);
  if (!resource) {
    resource = sharedResource<boolean | null>(async () => {
      const response = await fetch(`/api/projects/${projectId}/environment`);
      const data = (await response.json().catch(() => ({}))) as { kept?: boolean; error?: string };
      if (!response.ok || typeof data.kept !== "boolean") {
        throw new Error(data.error ?? "Could not read this project's environment.");
      }
      return data.kept;
    }, null);
    keptResources.set(projectId, resource);
  }
  return resource;
}

const noopSubscribe = () => () => {};

/** Stands in for a project's kept resource while there is no project. */
const NO_PROJECT = sharedResource<boolean | null>(async () => null, null);

export type FirstSessionEnvironment = {
  /** What the Mac has of the project's environment, offered until one is kept
   *  for it; null when there is nothing to offer (or not yet known). */
  offer: ScannedProjectEnv | null;
  pick: EnvironmentPick | null;
  setPick: (pick: EnvironmentPick) => void;
  /** The pick holds variables or files, which the user must agree to store. */
  secrets: boolean;
  consent: boolean;
  setConsent: (consent: boolean) => void;
  /** Keeping it now: the picks can't change under it. */
  keeping: boolean;
  /** Why the last keep failed. */
  error: string | null;
  /** Keep what is picked, before the session is created, so it starts with
   *  it. True when there was nothing to keep; false when it failed (`error`
   *  says why) and the session should not start without it. */
  keep: () => Promise<boolean>;
};

/**
 * The offer of a project's environment from this Mac as its first cloud
 * session starts: while nothing is kept for the project, the variables, .env
 * files and scripts the Mac has for its repository are offered on the
 * new-session form, and what is picked is kept as the session is started.
 * Only in the desktop app (the page can't read the Mac otherwise), and only
 * for a `cloud` session: one on this Mac has its environment already.
 */
export function useFirstSessionEnvironment(project: Project | undefined, cloud: boolean): FirstSessionEnvironment {
  const desktop = useSyncExternalStore(noopSubscribe, isDesktopApp, () => false);
  const enabled = desktop && cloud;
  const kept = useSharedResource(project && enabled ? keptResource(project.id) : NO_PROJECT);
  const scan = useSharedResource(macScan);
  const offerable = enabled && project !== undefined && kept.value === false;

  const projectId = project?.id;
  useEffect(() => {
    // Asked once a page; keeping one here asks again.
    if (enabled && projectId) keptResource(projectId).ensure().catch(() => {});
  }, [enabled, projectId]);
  useEffect(() => {
    // A failed scan offers nothing: the form works as it would without it.
    if (offerable) macScan.ensure().catch(() => {});
  }, [offerable]);

  // Picks and agreement are per repository: switching to another project
  // doesn't carry them over, and switching back finds them as left.
  const [picks, setPicks] = useState<Record<string, EnvironmentPick>>({});
  const [agreed, setAgreed] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [keeping, setKeeping] = useState(false);

  const offer = offerable && scan.value ? environmentFor(scan.value.projects, project.fullName) : null;
  const pick = offer ? (picks[offer.repo] ?? emptyEnvPick(offer.repo)) : null;
  const secrets = pick !== null && environmentPickSecrets(pick);
  const consent = offer !== null && agreed[offer.repo] === true;

  const keep = async () => {
    if (!offer || !pick || !hasEnvironmentPick(pick)) return true;
    if (secrets && !consent) return false;
    setError(null);
    setKeeping(true);
    try {
      const [result] = await importEnvironments([pick], {
        read: (repo, picked) => importEnvironment(repo, picked),
        save: (capture: ImportEnvCapture) => postJson<{ refused: string[] }>("/api/imports/environment", capture),
      });
      if (!result?.ok) {
        setError(`Couldn't keep ${offer.repo}'s environment. ${result?.message ?? "Try again."}`);
        return false;
      }
    } finally {
      setKeeping(false);
    }
    // Kept: the project's next session isn't its first, and a send after
    // this one fails to start doesn't keep it again.
    if (project) void keptResource(project.id).refresh();
    return true;
  };

  return {
    offer,
    pick,
    setPick: (next) => setPicks((current) => ({ ...current, [next.repo]: next })),
    secrets,
    consent,
    setConsent: (value) => offer && setAgreed((current) => ({ ...current, [offer.repo]: value })),
    keeping,
    error,
    keep,
  };
}
