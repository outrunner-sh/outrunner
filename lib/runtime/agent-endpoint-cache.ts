import type { AgentEndpoint } from "@/lib/runtime/sandbox/backend";

/**
 * How long a box's agent endpoint is reused. Under Daytona's signed preview URL
 * (5 minutes, lib/runtime/sandbox/daytona.ts), so any URL handed out still has
 * a minute to be opened in; the other providers' endpoints don't expire.
 */
export const AGENT_ENDPOINT_TTL_MS = 4 * 60_000;

type Entry = { endpoint: Promise<AgentEndpoint>; at: number };

/**
 * Where each box's agent is reached, kept for a few minutes: looking it up asks
 * the sandbox provider (Daytona: the box, then two preview links), and every
 * session attach, message and model switch needs it. Keyed by provider and box,
 * so a new box never gets an old box's endpoint. Holds no secret: the box's
 * agent secret is added by the caller.
 *
 * Lookups at the same time share one; a failed one is not kept, so the next
 * caller asks again. `fresh` skips what is kept (after a connection to it
 * failed) and keeps the new answer instead.
 */
export class AgentEndpointCache {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  // Plain fields, not parameter properties: Node's strip-only TypeScript (the
  // test runner) can't run those.
  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? AGENT_ENDPOINT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get(key: string, load: () => Promise<AgentEndpoint>, options: { fresh?: boolean } = {}): Promise<AgentEndpoint> {
    const kept = this.entries.get(key);
    if (kept && !options.fresh && this.now() - kept.at < this.ttlMs) return kept.endpoint;

    const entry: Entry = { endpoint: load(), at: this.now() };
    this.entries.set(key, entry);
    entry.endpoint.catch(() => {
      // Only this lookup's entry: a newer one may have replaced it meanwhile.
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.endpoint;
  }

  /** Drop a box's endpoint: the box is gone. */
  forget(key: string): void {
    this.entries.delete(key);
  }
}
