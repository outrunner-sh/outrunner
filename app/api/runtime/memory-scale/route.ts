import { NextResponse } from "next/server";

import { sessionPlan } from "@/lib/billing/entitlements";
import { claimLease } from "@/lib/billing/metering-store";
import { openAgentSecretOrNull } from "@/lib/db/computer-secret";
import { ownSandboxKeys } from "@/lib/db/credentials";
import { memberRole } from "@/lib/db/orgs";
import { boxSize } from "@/lib/runtime/box-sizes";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { requestMemoryScale } from "@/lib/runtime/memory-scale-request";
import { getRuntimeProvider } from "@/lib/runtime/provider";
import { providerNamed } from "@/lib/runtime/sandbox-choice";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** Signed pressure notifications from the box's runtime agent. Sessions don't
 * have its secret and cannot raise their own limits. */
export async function POST(request: Request) {
  try {
    const { status, body } = await requestMemoryScale({
      async computer(sandboxId) {
        const { data, error } = await createSupabaseAdminClient()
          .from("runtime_computers")
          .select("id, owner_id, org_id, agent_secret, provider")
          .eq("daytona_sandbox_id", sandboxId)
          .eq("status", "ready")
          .eq("pooled", false)
          .maybeSingle();
        if (error) throw error;
        // A computer made before provider recording belongs to the
        // deployment's provider, as it does in the rest of its lifecycle.
        const name = data?.provider ?? getRuntimeProvider().name;
        if (name !== "daytona" && name !== "user-daytona") return null;
        // Sealed at rest (lib/db/computer-secret.ts): the box signs with the
        // secret itself, as it does every other route's request.
        return data
          ? { id: data.id, ownerId: data.owner_id, orgId: data.org_id, agentSecret: openAgentSecretOrNull(data.agent_secret, data.id) }
          : null;
      },
      isMember: async (computer) => (await memberRole(computer.orgId, computer.ownerId)) !== null,
      claim: (sandboxId) => claimLease(`memory-scale:${sandboxId}`, 90),
      maxMemoryGb: async (computer) => boxSize((await sessionPlan(computer.ownerId, computer.orgId)).largestBoxSize).memoryGb,
      async grow(computer, sandboxId, maxMemoryGb, resizeBefore) {
        // Read the recorded provider again: changing a user's default must
        // never send a running box's request to another provider/account.
        const { data, error } = await createSupabaseAdminClient().from("runtime_computers")
          .select("provider").eq("id", computer.id).eq("daytona_sandbox_id", sandboxId).eq("status", "ready").maybeSingle();
        if (error) throw error;
        if (!data) return { outcome: "unavailable" };
        const name = data.provider ?? getRuntimeProvider().name;
        if (name !== "daytona" && name !== "user-daytona") return { outcome: "unavailable" };
        const provider = providerNamed(name, ownSandboxKeys(computer.ownerId));
        if (!provider || !isComputerProvider(provider)) return { outcome: "unavailable" };
        const result = await provider.scaleComputerMemory(sandboxId, maxMemoryGb, resizeBefore);
        if (result.outcome === "scaled") console.info(`Memory autoscaling: box ${sandboxId} grew to ${result.memoryGb} GiB`);
        return result;
      },
    }, {
      sandboxId: request.headers.get("x-outrunner-sandbox"),
      timestamp: request.headers.get("x-outrunner-timestamp"),
      signature: request.headers.get("x-outrunner-signature"),
      body: await request.text(),
    });
    return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("Memory autoscaling failed", error);
    return NextResponse.json({ error: "Could not increase sandbox memory." }, { status: 503 });
  }
}
