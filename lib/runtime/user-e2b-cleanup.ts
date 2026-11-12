import type { StoredE2b } from "@/lib/db/credentials";
import { optionalEnv } from "@/lib/env";

/** What disconnecting a user's E2B removed from their account. */
export type E2bCleanup = { boxes: number; failed: number };

/** How many boxes are listed and killed at most on one disconnect. */
const MAX_BOXES = 200;

/**
 * Remove what Outrunner made in a user's E2B, as they disconnect it: every
 * box of this deployment's (labelled `runtime.role=computer` and, when this
 * deployment has a name, its `runtime.deployment`), running or paused, and
 * the box templates built there. Nothing else in their account is touched.
 * Best effort: they're told what was left, and the key is forgotten either
 * way, so nothing of theirs keeps running on Outrunner's account of it.
 */
export async function cleanUpUserE2b(userId: string, stored: StoredE2b): Promise<E2bCleanup> {
  const [{ Sandbox }, { userE2bSdkOptions }, { COMPUTER_ROLE, DEPLOYMENT_LABEL, ROLE_LABEL, deploymentName }, { deleteOtherUserE2bTemplates }] =
    await Promise.all([
      import("e2b"),
      import("@/lib/runtime/sandbox/e2b-sdk"),
      import("@/lib/runtime/orphan-boxes"),
      import("@/lib/runtime/e2b-template"),
    ]);
  const target = { apiKey: stored.apiKey, apiUrl: stored.apiUrl ?? undefined, sandboxUrl: stored.sandboxUrl ?? undefined };
  const options = await userE2bSdkOptions(target, 20_000);
  const deployment = deploymentName(optionalEnv("RUNTIME_BASE_URL"));
  const metadata = { [ROLE_LABEL]: COMPUTER_ROLE, ...(deployment ? { [DEPLOYMENT_LABEL]: deployment } : {}) };

  const ids: string[] = [];
  try {
    const pages = Sandbox.list({ ...options, query: { metadata, state: ["running", "paused"] }, limit: 100 });
    while (pages.hasNext && ids.length < MAX_BOXES) {
      for (const box of await pages.nextItems()) ids.push(box.sandboxId);
    }
  } catch (error) {
    console.warn(`Could not list user ${userId}'s Outrunner boxes in their E2B`, error);
  }
  let boxes = 0;
  let failed = 0;
  for (const id of ids.slice(0, MAX_BOXES)) {
    try {
      await Sandbox.kill(id, options);
      boxes += 1;
    } catch (error) {
      failed += 1;
      console.warn(`Could not delete box ${id} in user ${userId}'s E2B`, error);
    }
  }
  // Every one of the user's Outrunner templates there: none is kept.
  await deleteOtherUserE2bTemplates({ apiKey: stored.apiKey, apiUrl: stored.apiUrl ?? undefined, user: true }, userId, "");
  return { boxes, failed };
}
