/**
 * What becomes of a member's sessions in an org they left, or were removed
 * from (organization_removals, 20261028130000_org_members.sql). They can't
 * reach them any more (RLS), and the org shouldn't pay for them:
 *
 * - At once: each session's box is paused, keeping its disk, as the
 *   reconciler pauses an idle one; and their pooled boxes, made with their
 *   GitHub token, are deleted.
 * - REMOVED_KEEP_DAYS on, if they haven't come back: each box is deleted and
 *   each session ended, and the removal's record goes.
 *
 * Coming back within the time (an invite, an approved request) takes the
 * record away, and the sessions are theirs again, their boxes brought back as
 * any paused box is. Run for one removal as it happens, and for all of them on
 * the reconciler's cron. The I/O is behind {@link RemovalDeps}, so the rules
 * test on their own.
 *
 * Their GitHub App links go at once, in the database, as their membership
 * does (20261112130000_github_installation_sharing.sql): every link they made
 * of the org's installations into another org, their personal org included.
 */

export const REMOVED_KEEP_DAYS = 30;

export type Removal = { orgId: string; userId: string; removedAt: Date };

/** A box of the removed member's in the org. */
export type RemovedBox = {
  id: string;
  sandboxId: string | null;
  status: "provisioning" | "ready" | "error" | "stopped";
  pooled: boolean;
};

export type RemovalDeps = {
  now(): Date;
  /** Whether the removal still stands: not if they came back since it was
   *  read (an invite, an approved request). */
  stillRemoved(removal: Removal): Promise<boolean>;
  /** Their boxes in the org: their sessions' own, and their pooled ones. */
  boxes(removal: Removal): Promise<RemovedBox[]>;
  /** Their sessions in the org not ended yet. */
  sessions(removal: Removal): Promise<string[]>;
  /** Pause a running box, keeping its disk, and end its cloud usage. */
  pause(box: RemovedBox & { sandboxId: string }): Promise<void>;
  /** Delete a box for good and end its cloud usage. */
  remove(box: RemovedBox): Promise<void>;
  /** End a session for good. */
  end(sessionId: string): Promise<void>;
  /** The removal's record is done with. */
  forget(removal: Removal): Promise<void>;
  log(message: string, error?: unknown): void;
};

/** Whether a removal's sessions are past keeping. */
export function pastKeeping(removal: Removal, now: Date): boolean {
  return now.getTime() - removal.removedAt.getTime() >= REMOVED_KEEP_DAYS * 24 * 60 * 60 * 1000;
}

/** Do what's due for one removal. Each box and session on its own: one that
 *  fails is logged and tried again on the next run. Asked again first whether
 *  the removal stands, and again before deleting anything: a sweep reads every
 *  removal, then settles them one by one, and one who came back in between
 *  keeps what's theirs. */
export async function settleRemoval(removal: Removal, deps: RemovalDeps): Promise<void> {
  if (!(await deps.stillRemoved(removal))) return;
  const expired = pastKeeping(removal, deps.now());
  let failed = false;
  const attempt = async (what: string, step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      failed = true;
      deps.log(`Could not ${what} for ${removal.userId}, removed from org ${removal.orgId}`, error);
    }
  };

  const boxes = await deps.boxes(removal);
  if (expired && !(await deps.stillRemoved(removal))) return;
  for (const box of boxes) {
    if (box.pooled || expired) {
      if (box.sandboxId || box.pooled) await attempt(`delete box ${box.id}`, () => deps.remove(box));
    } else if (box.status === "ready" && box.sandboxId) {
      const running = { ...box, sandboxId: box.sandboxId };
      await attempt(`pause box ${box.id}`, () => deps.pause(running));
    }
  }
  if (!expired) return;
  for (const session of await deps.sessions(removal)) {
    await attempt(`end session ${session}`, () => deps.end(session));
  }
  if (!failed) await attempt("forget the removal", () => deps.forget(removal));
}
