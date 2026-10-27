/**
 * The warm pool: two boxes per project made ready ahead of its next sessions
 * and stopped (20261025120000_warm_pool.sql, 20261027150000_warm_hooks.sql),
 * each warmed with the project's warm hook first (runtime-agent warm.go). A new session takes it instead of
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

/** How many ready boxes a project keeps. */
export const POOL_SIZE = 2;

/** How long a pooled box may stay "provisioning" before its refill is taken
 *  for dead (a deploy or crash cut it off): longer than a clone and the warm
 *  hook's hour together. */
export const STALE_REFILL_MS = 90 * 60_000;

/** How long a project whose refill failed waits before the next try: a
 *  repository that can't be pooled (a clone that fails after minutes) isn't
 *  tried again on every session. A change to the project's setup (a new
 *  generation) tries again at once. */
export const REFILL_BACKOFF_MS = 60 * 60_000;

/** A pooled box as the refill sees it. */
export type PooledBox = Pick<
  RuntimeComputer,
  "id" | "status" | "provider" | "daytonaSandboxId" | "updatedAt" | "poolSlot" | "generation"
>;

export type WarmPoolDeps = {
  /** Whether this provider's boxes can be pooled: it pauses and restores
   *  them, and they're Outrunner's. */
  pools: boolean;
  /** The provider new sessions run on, which a pooled box must be made by. */
  provider: NonNullable<RuntimeComputer["provider"]>;
  /** How many ready boxes the project keeps (POOL_SIZE). */
  size: number;
  /** The generation of the project's setup a box is made from now; a box
   *  made from another is replaced. */
  generation: number | null;
  /** The project's pooled boxes. */
  pooled(): Promise<PooledBox[]>;
  /** Start a pooled box's row in `slot` with `secret`; null when another
   *  refill took the slot first. */
  claimSlot(slot: number, secret: string): Promise<Pick<RuntimeComputer, "id"> | null>;
  /** Make a box ready: tools, agent, the project's repository. `onBox` is
   *  told its id as soon as it exists. */
  make(secret: string, onBox: (sandboxId: string) => Promise<void>): Promise<{ sandboxId: string }>;
  /** Warm it: the project's files and warm hook in a checkout of its base
   *  branch, for the session that takes it. Throws when the hook fails. */
  warm(computerId: string, sandboxId: string, secret: string): Promise<void>;
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
  /** Take a box out of the pool: its row deleted only while it is still
   *  pooled. False when a session claimed it meanwhile, whose box it is now. */
  release(computerId: string): Promise<boolean>;
  /** Record a box whose delete failed after its row went: a failed row in
   *  `slot` keeping it, for the sweeper to delete. */
  leftover(slot: number, sandboxId: string): Promise<void>;
  newSecret(): string;
  now(): number;
};

/**
 * Fill the project's pool up to `size` ready boxes, one per free slot, each
 * made, warmed and stopped. How many were made.
 *
 * A pooled box is deleted and its slot made again when another provider made
 * it, its refill died mid-way, its failure's back-off is over, or it was
 * made from an older generation of the project's setup (one still being made
 * is left to finish, and goes at the next refill). While a refill of the
 * current setup is backing off after a failure, nothing more is made: the
 * project's sessions make their boxes as they would without a pool. A refill
 * that fails leaves no box, and its row marked failed.
 */
export async function refillPool(deps: WarmPoolDeps): Promise<number> {
  if (!deps.pools) return 0;
  const taken = new Set<number>();
  let backingOff = false;
  for (const existing of await deps.pooled()) {
    const age = deps.now() - new Date(existing.updatedAt).getTime();
    const foreign = existing.provider !== deps.provider;
    const abandoned = existing.status === "provisioning" && age > STALE_REFILL_MS;
    const outdated = existing.status !== "provisioning" && existing.generation !== deps.generation;
    const retry = existing.status === "error" && age > REFILL_BACKOFF_MS;
    if (foreign || abandoned || outdated || retry) {
      // Out of the pool first, then its box: a box a session has just
      // claimed (its row no longer pooled) is that session's, not deleted.
      if (!(await deps.release(existing.id))) continue;
      const sandboxId = existing.daytonaSandboxId;
      if (sandboxId) {
        const deleted = await deps.discard(sandboxId, existing.provider).then(
          () => true,
          (error: unknown) => {
            console.error(`Pooled box ${existing.id}'s sandbox ${sandboxId} couldn't be deleted`, error);
            return false;
          },
        );
        if (!deleted) {
          // Its row is gone: a failed one in its slot points the sweeper at
          // the box, which would otherwise run on, unseen.
          await deps.leftover(existing.poolSlot, sandboxId).catch((error: unknown) =>
            console.error(`Pooled sandbox ${sandboxId} couldn't be recorded: delete it by hand`, error),
          );
          taken.add(existing.poolSlot);
        }
      }
      continue;
    }
    taken.add(existing.poolSlot);
    if (existing.status === "error") backingOff = true;
  }
  if (backingOff) return 0;

  const free = Array.from({ length: deps.size }, (_, slot) => slot).filter((slot) => !taken.has(slot));
  const results = await Promise.allSettled(free.map((slot) => makeOne(deps, slot)));
  const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failure) throw failure.reason;
  return results.filter((r) => r.status === "fulfilled" && r.value).length;
}

/** Make, warm and stop one box in `slot`; false when another refill took the
 *  slot first. */
async function makeOne(deps: WarmPoolDeps, slot: number): Promise<boolean> {
  const secret = deps.newSecret();
  const row = await deps.claimSlot(slot, secret);
  if (!row) return false;

  let sandboxId: string | null = null;
  try {
    sandboxId = (
      await deps.make(secret, async (id) => {
        sandboxId = id;
        await deps.recordBox(row.id, id);
      })
    ).sandboxId;
    await deps.warm(row.id, sandboxId, secret);
    await deps.pause(sandboxId);
    if (!(await deps.ready(row.id, sandboxId))) {
      throw new Error("its row went while it was made (the sweep took it for dead)");
    }
    return true;
  } catch (error) {
    const deleted = sandboxId ? await deps.discard(sandboxId, deps.provider).then(() => true, () => false) : true;
    await deps.failed(row.id, deleted ? null : sandboxId).catch(() => {
      if (!deleted) console.warn(`Pooled box ${sandboxId} couldn't be deleted or recorded: delete it by hand`);
      return deps.forget(row.id).catch(() => {});
    });
    throw error;
  }
}
