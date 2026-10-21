/**
 * The import's collaborators for real: the server's import routes, and the
 * Mac app's capture and upload. One set, so the import page and onboarding
 * import the same way.
 */

import { postJson } from "@/lib/client/post-json";
import { importSession } from "@/lib/desktop/local-runtime";
import type { ImportDeps, ImportProgress } from "@/lib/imports/client";
import type { ImportCommitRequest, ImportPlanItem, ImportPlanRequest } from "@/lib/runtime/import-scan";

export function liveImportDeps(onProgress: (progress: ImportProgress) => void): ImportDeps {
  return {
    plan: async (request: ImportPlanRequest) => (await postJson<{ items: ImportPlanItem[] }>("/api/imports", request)).items,
    capture: importSession,
    commit: (request: ImportCommitRequest) => postJson<{ workspace: { id: string } }>("/api/imports/commit", request),
    onProgress,
  };
}
