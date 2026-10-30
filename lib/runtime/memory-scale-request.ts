import { mediaRequestValid } from "@/lib/media/box-auth";
import type { BoxRequest, Answer } from "@/lib/media/box-uploads";
import type { MemoryScaleResult } from "@/lib/runtime/memory-scaling";

export type ScalingComputer = { id: string; ownerId: string; orgId: string; agentSecret: string | null };
export type MemoryScaleDeps = {
  computer(sandboxId: string): Promise<ScalingComputer | null>;
  isMember(computer: ScalingComputer): Promise<boolean>;
  claim(sandboxId: string): Promise<boolean>;
  maxMemoryGb(computer: ScalingComputer): Promise<number>;
  grow(computer: ScalingComputer, sandboxId: string, maxMemoryGb: number, resizeBefore: number): Promise<MemoryScaleResult>;
};

/** The runtime agent can request a check, never an allocation of its choosing.
 * Entitlements and live cgroup pressure are checked on the server. */
export async function requestMemoryScale(deps: MemoryScaleDeps, request: BoxRequest): Promise<Answer> {
  if (!request.sandboxId || request.sandboxId.length > 200 || request.body !== "{}") {
    return { status: 400, body: { error: "Expected a box's memory pressure notification." } };
  }
  const sandboxId = request.sandboxId;
  const computer = await deps.computer(sandboxId);
  if (!computer?.agentSecret || !mediaRequestValid(computer.agentSecret, "memory-scale", { ...request, sandboxId })) {
    return { status: 401, body: { error: "Bad signature." } };
  }
  if (!await deps.isMember(computer)) return { status: 403, body: { error: "The owner is no longer an org member." } };
  // This lease also acts as the cooldown, across requests and server restarts.
  const claimingAt = Date.now();
  if (!await deps.claim(sandboxId)) return { status: 200, body: { outcome: "cooldown", retryAfterSeconds: 90 } };
  // A pause, replacement or deletion since authentication must not revive it.
  const live = await deps.computer(sandboxId);
  if (!live || live.id !== computer.id || live.agentSecret !== computer.agentSecret) {
    return { status: 200, body: { outcome: "unavailable", retryAfterSeconds: 300 } };
  }
  // Reserve 60 seconds for Daytona's resize and a 5-second margin inside the
  // 90-second lease. Check this deadline again immediately before mutating.
  const result = await deps.grow(live, sandboxId, await deps.maxMemoryGb(live), claimingAt + 25_000);
  return { status: 200, body: { ...result, retryAfterSeconds: result.outcome === "at-limit" ? 300 : 90 } };
}
