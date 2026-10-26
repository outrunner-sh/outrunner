/**
 * The warm pool: one box per project made ready ahead of its next session and
 * stopped (20261025120000_warm_pool.sql). A new session takes it instead of
 * making a box: it starts again on its disk in about a second, its tools,
 * agent and repository already there, so the session opens in about 4
 * seconds rather than 19 (measured on Daytona), and a large repository is
 * fetched rather than cloned for minutes.
 *
 * Made after a session of the project is set up, for the next one: a
 * project's first session makes its box as before. Only on Outrunner's own
 * sandboxes that pause and restore (Daytona): a user's own account would be
 * billed for a box they didn't ask for.
 *
 * The I/O is behind {@link WarmPoolDeps}, so the rules are tested alone; the
 * wiring is warm-pool.deps.ts.
 */

import type { RuntimeComputer } from "@/lib/runtime/types";

/** How long a pooled box may stay "provisioning" before its refill is taken
 *  for dead (a deploy or crash cut it off): longer than any clone. */
export const STALE_REFILL_MS = 30 * 60_000;

/** How long a project whose refill failed waits before the next try: a
 *  repository that can't be pooled (a clone that fails after minutes) isn't
 *  tried again on every session. */
export const REFILL_BACKOFF_MS = 60 * 60_000;

/** The project's pooled box as the refill sees it. */
export type PooledBox = Pick<RuntimeComputer, "id" | "status" | "provider" | "daytonaSandboxId" | "updatedAt">;

export type WarmPoolDeps = {
  /** Whether this provider's boxes can be pooled: it pauses and restores
   *  them, and they're Outrunner's. */
  pools: boolean;
  /** The provider new sessions run on, which a pooled box must be made by. */
  provider: NonNullable<RuntimeComputer["provider"]>;
  /** The project's pooled box, if it has one. */
  pooled(): Promise<PooledBox | null>;
  /** Start the pooled box's row with `secret`; null when another refill
   *  started one first. */
  claimSlot(secret: string): Promise<Pick<RuntimeComputer, "id"> | null>;
  /** Make a box ready: tools, agent, the project's repository. `onBox` is
   *  told its id as soon as it exists. */
  make(secret: string, onBox: (sandboxId: string) => Promise<void>): Promise<{ sandboxId: string }>;
  /** Put a box's id on its row while it's still being made. */
  recordBox(computerId: string, sandboxId: string): Promise<void>;
  /** Stop it, keeping its disk. */
  pause(sandboxId: string): Promise<void>;
  /** Record it stopped and ready to take; false when its row is gone (the
   *  sweep took this refill for dead), which leaves the box the refill's to
   *  delete. */
  ready(computerId: string, sandboxId: string): Promise<boolean>;
  /** Keep a failed refill's row for the back-off, with the box its delete
   *  failed to remove (null when there is none): the retry deletes it. */
  failed(computerId: string, leftover: string | null): Promise<void>;
  /** Delete a box, with the provider that made it. One whose provider can't
   *  be reached is logged, not thrown: its row can't help delete it. */
  discard(sandboxId: string, provider: PooledBox["provider"]): Promise<void>;
  /** Forget a pooled box's row. */
  forget(computerId: string): Promise<void>;
  newSecret(): string;
  now(): number;
};

/**
 * Make the project's pooled box when it has none to take. Whether one was
 * made. A pooled box another provider made, or one whose refill died
 * mid-way, is deleted and replaced: left, it would block the pool for good,
 * and a box being made may be running. A refill that fails leaves no box, and
 * its row marked failed, so the project waits REFILL_BACKOFF_MS before the
 * next try; its sessions make their boxes as they would without a pool.
 */
export async function refillPool(deps: WarmPoolDeps): Promise<boolean> {
  if (!deps.pools) return false;
  const existing = await deps.pooled();
  if (existing) {
    const age = deps.now() - new Date(existing.updatedAt).getTime();
    const foreign = existing.provider !== deps.provider;
    const abandoned = existing.status === "provisioning" && age > STALE_REFILL_MS;
    const retry = existing.status === "error" && age > REFILL_BACKOFF_MS;
    if (!foreign && !abandoned && !retry) return false;
    if (existing.daytonaSandboxId) await deps.discard(existing.daytonaSandboxId, existing.provider);
    await deps.forget(existing.id);
  }
  const secret = deps.newSecret();
  const slot = await deps.claimSlot(secret);
  if (!slot) return false;

  let sandboxId: string | null = null;
  try {
    sandboxId = (
      await deps.make(secret, async (id) => {
        sandboxId = id;
        await deps.recordBox(slot.id, id);
      })
    ).sandboxId;
    await deps.pause(sandboxId);
    if (!(await deps.ready(slot.id, sandboxId))) {
      throw new Error("its row went while it was made (the sweep took it for dead)");
    }
    return true;
  } catch (error) {
    const deleted = sandboxId ? await deps.discard(sandboxId, deps.provider).then(() => true, () => false) : true;
    await deps.failed(slot.id, deleted ? null : sandboxId).catch(() => {
      if (!deleted) console.warn(`Pooled box ${sandboxId} couldn't be deleted or recorded: delete it by hand`);
      return deps.forget(slot.id).catch(() => {});
    });
    throw error;
  }
}
