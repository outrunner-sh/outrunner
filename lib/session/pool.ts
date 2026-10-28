/**
 * Work through a list `width` at a time, starting the next item as soon as any
 * one finishes (not when the slowest of a batch does), and starting none once
 * `until` has passed: what's started still finishes. Pure (no I/O of its
 * own), so it's unit-tested in Node.
 */
export async function inPool<T>(
  items: readonly T[],
  width: number,
  work: (item: T) => Promise<void>,
  { until = Infinity, now = Date.now }: { until?: number; now?: () => number } = {},
): Promise<{ started: number }> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && now() < until) {
      const item = items[next++];
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return { started: next };
}
