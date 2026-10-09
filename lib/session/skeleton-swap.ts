/**
 * When a skeleton shows, after interior.dev's Skeleton Swap: not at all for a
 * load that finishes within SKELETON_DELAY_MS (a flash is worse than a pause),
 * and once shown, for at least SKELETON_MIN_VISIBLE_MS, so it cannot blink.
 */
export const SKELETON_DELAY_MS = 120;
export const SKELETON_MIN_VISIBLE_MS = 380;

export type SkeletonDecision = {
  /** Whether the skeleton is up now. */
  show: boolean;
  /** When to decide again, in ms; null when nothing changes until `ready` does. */
  recheckIn: number | null;
};

export function skeletonDecision(input: {
  ready: boolean;
  /** When the current load began. */
  loadingSince: number;
  /** When the skeleton went up; null while it is not. */
  shownAt: number | null;
  now: number;
}): SkeletonDecision {
  const { ready, loadingSince, shownAt, now } = input;
  if (!ready) {
    if (shownAt !== null) return { show: true, recheckIn: null };
    const waited = now - loadingSince;
    return waited >= SKELETON_DELAY_MS
      ? { show: true, recheckIn: null }
      : { show: false, recheckIn: SKELETON_DELAY_MS - waited };
  }
  if (shownAt === null) return { show: false, recheckIn: null };
  const up = now - shownAt;
  return up >= SKELETON_MIN_VISIBLE_MS
    ? { show: false, recheckIn: null }
    : { show: true, recheckIn: SKELETON_MIN_VISIBLE_MS - up };
}
