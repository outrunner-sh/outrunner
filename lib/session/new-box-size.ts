import { sessionPlan } from "@/lib/billing/entitlements";
import type { SandboxSettings } from "@/lib/db/credentials";
import { orgDefaultsFor } from "@/lib/db/org-defaults";
import { newBoxSize } from "@/lib/orgs/defaults";
import type { BoxSizeId } from "@/lib/runtime/box-sizes";
import type { BoxResources } from "@/lib/runtime/sandbox/backend";
import { boxSizeOn } from "@/lib/runtime/sandbox-choice";

/**
 * The CPU and memory a new box of the owner's gets on their sandbox: the size
 * `asked` (an API or automation caller's), else theirs once they chose one,
 * else their org's default (lib/orgs/defaults.ts), never beyond what the
 * plan allows. Undefined where the sandbox keeps its own default (a user's
 * own Daytona). New sessions, the warm pool's boxes and a restore that needs
 * a new box all size one this way, so a pooled box is the box the session
 * would have made.
 */
export async function newBoxResources(input: {
  ownerId: string;
  orgId: string;
  settings: SandboxSettings;
  asked?: BoxSizeId;
}): Promise<BoxResources | undefined> {
  const size = input.asked ?? newBoxSize(input.settings, (await orgDefaultsFor(input.orgId)).boxSize);
  return boxSizeOn(input.settings.sandbox, size, await sessionPlan(input.ownerId, input.orgId));
}
