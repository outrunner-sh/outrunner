"use client";

import { useEffect } from "react";

import { useSharedResource } from "@/hooks/use-shared-resource";
import { workspaceModelMenu, type OutrunnerModels } from "@/lib/desktop/local-runtime";

/**
 * The user's model menu, from the one answer the page keeps: the last one at
 * once wherever it is shown, looked up only when there is none yet or it went
 * out of date (forgetOutrunnerModels). Null until the first answer; none on
 * offer when that look failed.
 */
export function useOutrunnerModels(workspaceId?: string): OutrunnerModels | null {
  const resource = workspaceModelMenu(workspaceId);
  const models = useSharedResource(resource);
  useEffect(() => {
    void resource.ensure().catch(() => {});
  }, [resource]);
  return models.status === "loading" ? null : models.value;
}
