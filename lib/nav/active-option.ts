/**
 * Which option of a list the arrow keys are on, kept by the option's key
 * rather than its position: when the list changes under it (a search, a
 * Refresh that re-sorts or shortens it), the same option stays active, and
 * one that is gone gives way to the first. Its index always names an option
 * that exists, so what is highlighted and what Enter opens are one and the
 * same.
 */
export function activeIndexOf<T, K>(items: readonly T[], keyOf: (item: T) => K, activeKey: K | null): number {
  if (items.length === 0) return -1;
  if (activeKey === null) return 0;
  const index = items.findIndex((item) => keyOf(item) === activeKey);
  return index === -1 ? 0 : index;
}

/** The index `step` away from `index`, wrapping round a list of `length`. */
export function stepIndex(length: number, index: number, step: number): number {
  if (length === 0) return -1;
  return (((Math.max(index, 0) + step) % length) + length) % length;
}
