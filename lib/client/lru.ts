/**
 * A map that keeps only the `limit` most recently used entries: reading or
 * writing one makes it the most recent, and the least recent goes past the
 * limit. For what a page keeps per session, so a long-running app doesn't grow
 * without end.
 */
export class Lru<V> {
  private readonly entries = new Map<string, V>();
  private readonly limit: number;

  // A plain field, not a parameter property: Node's strip-only TypeScript (the
  // test runner) can't run those.
  constructor(limit: number) {
    this.limit = limit;
  }

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) this.set(key, value);
    return value;
  }

  /** Whether it holds `key`, leaving it as recent as it was. */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
