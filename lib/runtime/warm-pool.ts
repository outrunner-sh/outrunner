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

export type WarmPoolDeps = {
  /** Whether this provider's boxes can be pooled: it pauses and restores
   *  them, and they're Outrunner's. */
  pools: boolean;
  /** The project's pooled box, if it has one. */
  pooled(): Promise<Pick<RuntimeComputer, "id"> | null>;
  /** Start the pooled box's row with `secret`; null when another refill
   *  started one first. */
  claimSlot(secret: string): Promise<Pick<RuntimeComputer, "id"> | null>;
  /** Make a box ready: tools, agent, the project's repository. */
  make(secret: string): Promise<{ sandboxId: string }>;
  /** Stop it, keeping its disk. */
  pause(sandboxId: string): Promise<void>;
  /** Record it stopped and ready to take. */
  ready(computerId: string, sandboxId: string): Promise<void>;
  /** A box made but not recorded: delete it, so it isn't left running. */
  discard(sandboxId: string): Promise<void>;
  /** Forget the row of a box that couldn't be made. */
  forget(computerId: string): Promise<void>;
  newSecret(): string;
};

/**
 * Make the project's pooled box when it has none. Whether one was made.
 * Best effort: a failure leaves no row and no box behind, and the next
 * session makes its box as it would without a pool.
 */
export async function refillPool(deps: WarmPoolDeps): Promise<boolean> {
  if (!deps.pools || (await deps.pooled())) return false;
  const secret = deps.newSecret();
  const slot = await deps.claimSlot(secret);
  if (!slot) return false;

  let sandboxId: string | null = null;
  try {
    sandboxId = (await deps.make(secret)).sandboxId;
    await deps.pause(sandboxId);
    await deps.ready(slot.id, sandboxId);
    return true;
  } catch (error) {
    if (sandboxId) await deps.discard(sandboxId).catch(() => {});
    await deps.forget(slot.id).catch(() => {});
    throw error;
  }
}
